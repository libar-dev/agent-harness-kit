import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const script = 'scripts/senpi-compatibility-probe.mts';
const temporaryRoots: string[] = [];

const probeReportSchema = z.object({
  candidateSha: z.string().min(1),
  gates: z.object({
    A: z.array(
      z.object({
        id: z.string(),
        verdict: z.string(),
        evidence: z.record(z.string(), z.unknown()),
        justification: z.string(),
      })
    ),
    B: z.array(z.unknown()),
  }),
  gateAResult: z.string(),
  gateBResult: z.string(),
  overall: z.string(),
  probe: z.object({
    manualCheckpointForced: z.boolean(),
    hashesUnchanged: z.boolean(),
    productApproval: z.object({
      ownerApproval: z.boolean(),
      blessedPi: z.boolean(),
      integrationReady: z.boolean(),
    }),
  }),
});

function runProbe(...args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Pi/Senpi compatibility probe', () => {
  it('maps every Gate A row deterministically without evaluating Gate B', () => {
    const first = runProbe();
    const second = runProbe();
    expect(second).toBe(first);

    const parsed: unknown = JSON.parse(first);
    const report = probeReportSchema.parse(parsed);

    expect(report.gates.A.map(row => row.id)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `A-${String(index + 1).padStart(2, '0')}`
      )
    );
    expect(
      report.gates.A.every(row => ['PASS', 'FAIL', 'N/A'].includes(row.verdict))
    ).toBe(true);
    expect(report.gates.A.every(row => row.justification === '')).toBe(true);
    expect(report.gates.B).toEqual([]);
    expect(report.gateAResult).toBe('FAIL');
    expect(report.gateBResult).toBe('NOT_EVALUATED');
    expect(report.overall).toBe('rejected');
    expect(report.probe).toMatchObject({
      manualCheckpointForced: true,
      hashesUnchanged: true,
      productApproval: {
        ownerApproval: false,
        blessedPi: false,
        integrationReady: false,
      },
    });
    // Real checkouts yield a git SHA; codeload/tarball archives have no .git
    // and fall back to 'unknown' so the probe (and prepack) still run.
    expect(
      report.candidateSha === 'unknown' ||
        /^[0-9a-f]{40}$/i.test(report.candidateSha)
    ).toBe(true);

    const evidenceFields: Record<string, string[]> = {
      'A-01': ['scheme', 'collisionPolicy', 'claudeIdsByteIdentical'],
      'A-02': ['encodingFunction', 'roundTrips', 'perProjectListing'],
      'A-03': ['bounded', 'cancellable', 'progressSignal'],
      'A-04': [
        'incrementalTail',
        'mode',
        'commitsAfterDurableApply',
        'staleConflictTyped',
      ],
      'A-05': ['detectsRewrite', 'emitsMutationEvents', 'modelDocumented'],
      'A-06': ['lossyByDesign', 'fallbackKind', 'provenancePersisted'],
      'A-07': ['exportsListed', 'esmDynamicImport', 'nodeRangeSatisfied'],
      'A-08': ['importsResolve', 'requiresPatching'],
      'A-09': [
        'watchDefaultsDocumented',
        'fallbackBounded',
        'noPerBlockListEvents',
      ],
      'A-10': ['versionedParser', 'observePathWritesNativeStore'],
    };
    for (const row of report.gates.A) {
      expect(Object.keys(row.evidence).sort()).toEqual(
        [...(evidenceFields[row.id] ?? [])].sort()
      );
    }
  });

  it('rejects an automatic-checkpoint temp fixture before probing', () => {
    const root = mkdtempSync(join(tmpdir(), 't29-auto-checkpoint-'));
    temporaryRoots.push(root);
    const descriptorPath = join(root, 'automatic.json');
    const descriptor = readFileSync(
      'tests/fixtures/senpi/compatibility-probe-v1.json',
      'utf8'
    ).replace('"checkpointMode": "manual"', '"checkpointMode": "automatic"');
    writeFileSync(descriptorPath, descriptor);

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', script, '--descriptor', descriptorPath],
      { cwd: process.cwd(), encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SenpiCompatibilityMutationGuardError');
    expect(result.stderr).toContain('checkpointMode=automatic');
    expect(result.stdout).toBe('');
  });
});
