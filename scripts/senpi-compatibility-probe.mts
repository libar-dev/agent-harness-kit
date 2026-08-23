#!/usr/bin/env -S pnpm exec tsx
/**
 * Fixture-first, non-mutating Pi/Senpi compatibility probe.
 *
 * This records library findings against the frozen future-harness checklist.
 * It is not an integration approval and does not expose a harness ABI.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  encodeSenpiCwdDirname,
  foldSenpiBlockChanges,
  listAllSenpiSessions,
  listSenpiSessions,
  tailSenpiSession,
} from '../src/senpi/processing/index.js';
import { getSenpiSessionMarkerPath } from '../src/senpi/processing/checkpoint.js';
import {
  assertSenpiSmokeProbeInputsUnchanged,
  hashSenpiSmokeProbeInputs,
  type SenpiSmokeProbeHash,
} from './senpi-smoke-safety.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultDescriptor = join(
  repoRoot,
  'tests/fixtures/senpi/compatibility-probe-v1.json'
);

interface ProbeDescriptor {
  readonly schemaVersion: 1;
  readonly subject: string;
  readonly evaluatedAt: string;
  readonly checkpointMode: 'automatic' | 'manual';
  readonly sessionFixture: string;
  readonly rewriteFixture: string;
}

interface ProtectedPath {
  readonly label: string;
  readonly path: string;
}

export class SenpiCompatibilityMutationGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenpiCompatibilityMutationGuardError';
  }
}

function loadDescriptor(path: string): ProbeDescriptor {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('schemaVersion' in raw) ||
    raw.schemaVersion !== 1 ||
    !('subject' in raw) ||
    typeof raw.subject !== 'string' ||
    !('evaluatedAt' in raw) ||
    typeof raw.evaluatedAt !== 'string' ||
    !('checkpointMode' in raw) ||
    (raw.checkpointMode !== 'manual' && raw.checkpointMode !== 'automatic') ||
    !('sessionFixture' in raw) ||
    typeof raw.sessionFixture !== 'string' ||
    !('rewriteFixture' in raw) ||
    typeof raw.rewriteFixture !== 'string'
  ) {
    throw new Error(`Invalid compatibility probe descriptor: ${path}`);
  }
  return raw as ProbeDescriptor;
}

function assertManualCheckpointMode(descriptor: ProbeDescriptor): void {
  if (descriptor.checkpointMode !== 'manual') {
    throw new SenpiCompatibilityMutationGuardError(
      'Mutation guard rejected checkpointMode=automatic; compatibility probes require manual checkpointing'
    );
  }
}

async function hashProtected(
  paths: readonly ProtectedPath[]
): Promise<readonly SenpiSmokeProbeHash[]> {
  return hashSenpiSmokeProbeInputs(paths.map(entry => entry.path));
}

function stableHashes(
  paths: readonly ProtectedPath[],
  hashes: readonly SenpiSmokeProbeHash[]
): Record<string, string> {
  return Object.fromEntries(
    paths.map((entry, index) => {
      const digest = hashes[index]?.digest;
      return [
        entry.label,
        digest?.startsWith('missing:') === true
          ? 'missing'
          : (digest ?? 'missing'),
      ];
    })
  );
}

async function readHeaderCwd(path: string): Promise<string> {
  const contents = await readFile(path, 'utf8');
  const first = contents.split('\n', 1)[0];
  if (first === undefined || first === '') {
    throw new Error(`Session fixture has no header: ${path}`);
  }
  const header: unknown = JSON.parse(first);
  if (
    typeof header !== 'object' ||
    header === null ||
    !('cwd' in header) ||
    typeof header.cwd !== 'string'
  ) {
    throw new Error(`Session fixture has no cwd: ${path}`);
  }
  return header.cwd;
}

function liveProtectedPaths(sessionPath: string, cwd: string): ProtectedPath[] {
  const markerPath = getSenpiSessionMarkerPath(sessionPath);
  const sessionsSegment = `${join('agent', 'sessions')}`;
  const marker = sessionPath.lastIndexOf(sessionsSegment);
  const agentHome =
    marker === -1
      ? dirname(dirname(sessionPath))
      : sessionPath.slice(0, marker + 'agent'.length);
  return [
    { label: 'live-source', path: sessionPath },
    { label: 'live-marker', path: markerPath },
    { label: 'live-config', path: join(agentHome, 'settings.json') },
    { label: 'live-agent-hooks', path: join(agentHome, 'hooks.json') },
    { label: 'live-project-hooks', path: join(cwd, '.senpi', 'hooks.json') },
    {
      label: 'live-project-trust',
      path: join(cwd, '.senpi', 'hooks-state.json'),
    },
  ];
}

async function runProbe(options: {
  readonly descriptorPath: string;
  readonly liveSession?: string;
}): Promise<Record<string, unknown>> {
  const descriptor = loadDescriptor(options.descriptorPath);
  assertManualCheckpointMode(descriptor);

  const fixtureSource = resolve(repoRoot, descriptor.sessionFixture);
  const rewriteFixture = resolve(repoRoot, descriptor.rewriteFixture);
  const source =
    options.liveSession === undefined
      ? fixtureSource
      : resolve(options.liveSession);
  const sourceCwd = await readHeaderCwd(source);
  const livePaths =
    options.liveSession === undefined
      ? []
      : liveProtectedPaths(source, sourceCwd);
  const liveBefore = await hashProtected(livePaths);

  const scratch = await mkdtemp(join(tmpdir(), 't29-pi-senpi-probe-'));
  try {
    const agentHome = join(scratch, 'agent');
    const projectCwd = sourceCwd;
    const sessionDir = join(
      agentHome,
      'sessions',
      encodeSenpiCwdDirname(projectCwd)
    );
    const sessionPath = join(sessionDir, 'probe-session.jsonl');
    const markerPath = getSenpiSessionMarkerPath(sessionPath, {
      markerDir: join(scratch, 'markers'),
      allowedMarkerRoots: [scratch],
    });
    const configPath = join(agentHome, 'settings.json');
    const agentHooksPath = join(agentHome, 'hooks.json');
    const projectHooksPath = join(scratch, 'project', '.senpi', 'hooks.json');
    const trustPath = join(scratch, 'project', '.senpi', 'hooks-state.json');

    await mkdir(sessionDir, { recursive: true });
    await mkdir(dirname(markerPath), { recursive: true });
    await mkdir(dirname(projectHooksPath), { recursive: true });
    await copyFile(source, sessionPath);
    await writeFile(markerPath, '{}\n');
    await writeFile(configPath, '{"fixture":true}\n');
    await writeFile(agentHooksPath, '{"hooks":{}}\n');
    await writeFile(projectHooksPath, '{"hooks":{}}\n');
    await writeFile(trustPath, '{"version":1,"hooks":{}}\n');

    const protectedPaths: ProtectedPath[] = [
      { label: 'source', path: source },
      { label: 'copied-transcript', path: sessionPath },
      { label: 'marker', path: markerPath },
      { label: 'config', path: configPath },
      { label: 'agent-hooks', path: agentHooksPath },
      { label: 'project-hooks', path: projectHooksPath },
      { label: 'trust', path: trustPath },
    ];
    const before = await hashProtected(protectedPaths);

    const all = await listAllSenpiSessions({ agentHome });
    const scoped = await listSenpiSessions(projectCwd, { agentHome });
    const valid = scoped.filter(entry => entry.kind === 'valid');
    if (valid.length !== 1) {
      throw new Error(
        `Expected one scoped fixture session, found ${valid.length}`
      );
    }

    const first = await tailSenpiSession(sessionPath, {
      checkpointMode: 'manual',
      markerDir: dirname(markerPath),
      allowedMarkerRoots: [scratch],
      includeOffPath: true,
    });
    const second = await tailSenpiSession(sessionPath, {
      checkpointMode: 'manual',
      checkpoint: first.checkpoint,
      markerDir: dirname(markerPath),
      allowedMarkerRoots: [scratch],
      includeOffPath: true,
    });
    const blocks = foldSenpiBlockChanges(first.changes);

    // Rewrite detection is exercised only on an expendable simulation copy;
    // the copied probe transcript above remains protected and byte-identical.
    const rewritePath = join(scratch, 'rewrite-simulation.jsonl');
    await copyFile(source, rewritePath);
    const rewriteInitial = await tailSenpiSession(rewritePath, {
      checkpointMode: 'manual',
    });
    await copyFile(rewriteFixture, rewritePath);
    const rewriteResult = await tailSenpiSession(rewritePath, {
      checkpointMode: 'manual',
      checkpoint: rewriteInitial.checkpoint,
    });

    const after = await hashProtected(protectedPaths);
    assertSenpiSmokeProbeInputsUnchanged(before, after);
    const liveAfter = await hashProtected(livePaths);
    assertSenpiSmokeProbeInputsUnchanged(liveBefore, liveAfter);

    const packageJson = JSON.parse(
      await readFile(join(repoRoot, 'package.json'), 'utf8')
    ) as {
      exports?: Record<string, unknown>;
      engines?: { node?: string };
    };
    const processingModule =
      await import('@libar-dev/agent-harness-kit/senpi/processing');
    const senpiModule = await import('@libar-dev/agent-harness-kit/senpi');
    const exportsListed = ['./senpi', './senpi/processing'].filter(
      subpath => packageJson.exports?.[subpath] !== undefined
    );
    const dynamicImportsLoaded =
      typeof processingModule.tailSenpiSession === 'function' &&
      typeof senpiModule.resolveSenpiAgentHome === 'function';
    const nodeMajor = Number.parseInt(
      process.versions.node.split('.')[0] ?? '0',
      10
    );
    const hasProvenance = blocks.every(
      block => block.entryId !== '' && block.origin !== undefined
    );
    const rewriteDetected =
      rewriteResult.reset &&
      rewriteResult.mutations.some(mutation => mutation.index === 0);
    const forkDetected = first.offPath.length > 0;
    const incrementalTail =
      second.previousByteOffset === first.nextByteOffset &&
      second.nextByteOffset === first.nextByteOffset &&
      second.mutations.length === 0;

    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();

    return {
      schemaVersion: 1,
      subject: descriptor.subject,
      candidateSha,
      evaluatedAt: descriptor.evaluatedAt,
      gates: {
        A: [
          row(
            'A-01',
            'FAIL',
            {
              identity: {
                scheme: 'native-id',
                collisionPolicy: 'none',
                claudeIdsByteIdentical: true,
              },
            }.identity
          ),
          row(
            'A-02',
            'FAIL',
            {
              projectScoping: {
                encodingFunction: 'encodeSenpiCwdDirname',
                roundTrips: false,
                perProjectListing: valid.length === 1,
              },
            }.projectScoping
          ),
          row(
            'A-03',
            'FAIL',
            {
              discovery: {
                bounded: true,
                cancellable: false,
                progressSignal: null,
              },
            }.discovery
          ),
          row(
            'A-04',
            incrementalTail ? 'PASS' : 'FAIL',
            {
              checkpointing: {
                incrementalTail,
                mode: 'manual',
                commitsAfterDurableApply: true,
                staleConflictTyped:
                  typeof processingModule.StaleCheckpointConflict ===
                  'function',
              },
            }.checkpointing
          ),
          row(
            'A-05',
            rewriteDetected && forkDetected ? 'PASS' : 'FAIL',
            {
              resetFork: {
                detectsRewrite: rewriteDetected,
                emitsMutationEvents:
                  rewriteResult.mutations.length > 0 &&
                  first.mutations.length > 0,
                modelDocumented:
                  'docs/reference/senpi-adapter.md#session-v3-tree-projection-tail-and-checkpoints',
              },
            }.resetFork
          ),
          row(
            'A-06',
            'FAIL',
            {
              normalization: {
                lossyByDesign: false,
                fallbackKind: 'native-metadata',
                provenancePersisted: false,
              },
            }.normalization
          ),
          row(
            'A-07',
            exportsListed.length === 2 &&
              dynamicImportsLoaded &&
              nodeMajor >= 22
              ? 'PASS'
              : 'FAIL',
            {
              package: {
                exportsListed,
                esmDynamicImport: dynamicImportsLoaded,
                nodeRangeSatisfied:
                  packageJson.engines?.node === '>=22.0.0' && nodeMajor >= 22,
              },
            }.package
          ),
          row(
            'A-08',
            exportsListed.length === 2 ? 'PASS' : 'FAIL',
            {
              cleanConsumer: {
                importsResolve: exportsListed.length === 2,
                requiresPatching: false,
              },
            }.cleanConsumer
          ),
          row(
            'A-09',
            'FAIL',
            {
              performance: {
                watchDefaultsDocumented: true,
                fallbackBounded: false,
                noPerBlockListEvents: true,
              },
            }.performance
          ),
          row(
            'A-10',
            'PASS',
            {
              persistence: {
                versionedParser: true,
                observePathWritesNativeStore: false,
              },
            }.persistence
          ),
        ],
        B: [],
      },
      gateAResult: 'FAIL',
      gateBResult: 'NOT_EVALUATED',
      overall: 'rejected',
      probe: {
        reportVersion: 1,
        sourceKind:
          options.liveSession === undefined
            ? 'sanitized-fixture'
            : 'read-only-live-copy',
        manualCheckpointForced: true,
        autoCheckpointRejected: true,
        hashesUnchanged: true,
        protectedHashesBefore: stableHashes(protectedPaths, before),
        protectedHashesAfter: stableHashes(protectedPaths, after),
        liveSourceHashesBefore: stableHashes(livePaths, liveBefore),
        liveSourceHashesAfter: stableHashes(livePaths, liveAfter),
        discovery: {
          allCount: all.length,
          scopedCount: scoped.length,
          nativeIdentity: valid[0]?.info.id ?? null,
          canonicalIdentityAvailable: false,
          collisionQuarantineAvailable: false,
        },
        incrementalTail: {
          verified: incrementalTail,
          firstOffset: first.nextByteOffset,
          secondOffset: second.nextByteOffset,
        },
        resetFork: {
          rewriteDetected,
          forkDetected,
          offPathCount: first.offPath.length,
        },
        provenance: {
          availableOnNativeBlocks: hasProvenance,
          persistedForCockpitTranscriptBlocks: false,
        },
        productApproval: {
          ownerApproval: false,
          blessedPi: false,
          integrationReady: false,
        },
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function row(
  id: string,
  verdict: 'PASS' | 'FAIL' | 'N/A',
  evidence: Record<string, unknown>
): Record<string, unknown> {
  return { id, verdict, evidence, justification: '' };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      descriptor: { type: 'string', default: defaultDescriptor },
      'live-session': { type: 'string' },
      output: { type: 'string' },
    },
  });
  const report = await runProbe({
    descriptorPath: resolve(values.descriptor),
    ...(values['live-session'] === undefined
      ? {}
      : { liveSession: values['live-session'] }),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output === undefined) {
    process.stdout.write(json);
  } else {
    const output = resolve(values.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    );
    process.exitCode = 1;
  });
}
