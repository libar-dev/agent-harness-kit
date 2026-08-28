/**
 * Node worker entry: byte-identical behavior + AST branches + V8 coverage.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import inspector from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveReachableParserFunctions } from './senpi-upstream-output-callgraph.js';
import {
  assertAllBranchesHit,
  instrumentParserBranches,
} from './senpi-upstream-output-instrument.js';
import {
  assertOutputParseParity,
  runAllOutputScenarios,
} from './senpi-upstream-output-scenarios-run.js';
import { forceJsonRethrow, loadParserVm } from './senpi-upstream-output-vm.js';

const root = process.cwd();
const VENDORED = path.join(root, 'docs/upstream/senpi/hooks/output-parser.js');
const PIN = path.join(root, 'docs/upstream/senpi/pin.json');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function pinSha(): string {
  const parsed: unknown = JSON.parse(readFileSync(PIN, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('invalid pin');
  }
  const files: unknown = Reflect.get(parsed, 'files');
  if (typeof files !== 'object' || files === null) {
    throw new Error('pin files missing');
  }
  const parser: unknown = Reflect.get(files, 'hooks/output-parser.js');
  if (typeof parser !== 'object' || parser === null) {
    throw new Error('pin parser missing');
  }
  const sha: unknown = Reflect.get(parser, 'sha256');
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new Error('pin missing output-parser.js');
  }
  return sha;
}

function assertV8(
  entry: {
    functions: readonly {
      functionName?: string;
      ranges: readonly {
        startOffset: number;
        endOffset: number;
        count: number;
      }[];
    }[];
  },
  reachable: ReturnType<typeof deriveReachableParserFunctions>
): number {
  const byName = new Map(reachable.map(r => [r.name, r]));
  let rangeCount = 0;
  const uncovered: string[] = [];
  const hit = new Set<string>();
  for (const fn of entry.functions) {
    for (const range of fn.ranges) {
      const named = fn.functionName ? byName.get(fn.functionName) : undefined;
      const owners =
        named && range.startOffset < named.end && range.endOffset > named.start
          ? [named]
          : reachable.filter(
              r => range.startOffset < r.end && range.endOffset > r.start
            );
      if (owners.length === 0) continue;
      rangeCount += 1;
      for (const o of owners) hit.add(o.name);
      if (range.count === 0) {
        uncovered.push(
          `${owners.map(o => o.name).join('|')}:${range.startOffset}-${range.endOffset}`
        );
      }
    }
  }
  const missing = reachable.map(r => r.name).filter(n => !hit.has(n));
  if (missing.length > 0) {
    throw new Error(`reachable never seen: ${missing.join(',')}`);
  }
  if (uncovered.length > 0) {
    throw new Error(`coverage gaps: ${uncovered.join(',')}`);
  }
  return rangeCount;
}

async function main(): Promise<void> {
  const pinned = pinSha();
  const vendored = readFileSync(VENDORED);
  const vendoredSha = sha256(vendored);
  const dir = mkdtempSync(path.join(tmpdir(), 'senpi-parser-'));
  try {
    const parserPath = path.join(dir, 'output-parser.js');
    const diagPath = path.join(dir, 'diagnostics.js');
    const instPath = path.join(dir, 'output-parser.instrumented.js');
    copyFileSync(VENDORED, parserPath);
    const { DIAGNOSTICS_SHIM } = await import('./senpi-upstream-output-vm.js');
    writeFileSync(diagPath, DIAGNOSTICS_SHIM);
    const loaded = readFileSync(parserPath);
    if (sha256(loaded) !== vendoredSha) {
      throw new Error('temp copy sha mismatch');
    }
    const sourceText = loaded.toString('utf8');
    const moduleUrl = pathToFileURL(parserPath).href;
    const reachable = deriveReachableParserFunctions(sourceText);

    const session = new inspector.Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true,
    });

    const byte = await loadParserVm({
      sourceText,
      moduleUrl,
      diagPath,
    });
    const scenarioCount = runAllOutputScenarios(byte.parse);
    forceJsonRethrow(byte.parse);

    const cov = await session.post('Profiler.takePreciseCoverage');
    await session.post('Profiler.stopPreciseCoverage');
    session.disconnect();

    const want = realpathSync(parserPath);
    const entry = cov.result.find(r => {
      try {
        return (
          r.url.startsWith('file:') &&
          realpathSync(fileURLToPath(r.url.split('?')[0] ?? r.url)) === want
        );
      } catch {
        return false;
      }
    });
    if (!entry) throw new Error('coverage entry missing for exact parser path');
    const rangeCount = assertV8(entry, reachable);

    const instrumented = instrumentParserBranches(sourceText);
    writeFileSync(instPath, instrumented.source);
    const inst = await loadParserVm({
      sourceText: instrumented.source,
      moduleUrl: pathToFileURL(instPath).href,
      diagPath,
    });
    runAllOutputScenarios(inst.parse);
    forceJsonRethrow(inst.parse);
    assertOutputParseParity(byte.parse, inst.parse);
    assertAllBranchesHit(inst.counters(), instrumented.branchIds);

    process.stdout.write(
      JSON.stringify({
        scenarioCount,
        reachableFunctionCount: reachable.length,
        rangeCount,
        branchCounterCount: instrumented.branchIds.length,
        sha256: sha256(loaded),
        pinnedSha256: pinned,
        matchesPin: sha256(loaded) === pinned,
        instrumentedSha256: sha256(Buffer.from(instrumented.source)),
        reachableNames: reachable.map(r => r.name),
      })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
