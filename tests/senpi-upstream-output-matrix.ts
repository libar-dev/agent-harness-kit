/** Spawns Node worker for dual-run parser matrix (byte-identical + instrumented). */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type MatrixReceipt = {
  readonly scenarioCount: number;
  readonly reachableFunctionCount: number;
  readonly rangeCount: number;
  readonly branchCounterCount: number;
  readonly sha256: string;
  readonly pinnedSha256: string;
  readonly matchesPin: boolean;
  readonly instrumentedSha256: string;
  readonly reachableNames: readonly string[];
};

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
    return undefined;
  }
  return value;
}

export function assertOutputBehaviorMatrix(): MatrixReceipt {
  const worker = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'senpi-upstream-output-worker.ts'
  );
  const result = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', '--import', 'tsx', worker],
    {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `output-parser matrix worker failed:\n${result.stderr}\n${result.stdout}`
    );
  }
  const line = result.stdout
    .trim()
    .split('\n')
    .filter(l => l.startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`no receipt: ${result.stdout}`);
  const receipt: unknown = JSON.parse(line);
  if (!isUnknownRecord(receipt)) throw new Error('invalid receipt');
  const getNum = (k: string): number => {
    const v = receipt[k];
    if (typeof v !== 'number') throw new Error(`receipt.${k}`);
    return v;
  };
  const getStr = (k: string): string => {
    const v = receipt[k];
    if (typeof v !== 'string') throw new Error(`receipt.${k}`);
    return v;
  };
  const names = stringArray(receipt['reachableNames']);
  if (!names) throw new Error('receipt.reachableNames');
  const matchesPin = receipt['matchesPin'];
  if (typeof matchesPin !== 'boolean') throw new Error('receipt.matchesPin');
  return {
    scenarioCount: getNum('scenarioCount'),
    reachableFunctionCount: getNum('reachableFunctionCount'),
    rangeCount: getNum('rangeCount'),
    branchCounterCount: getNum('branchCounterCount'),
    sha256: getStr('sha256'),
    pinnedSha256: getStr('pinnedSha256'),
    matchesPin,
    instrumentedSha256: getStr('instrumentedSha256'),
    reachableNames: names,
  };
}
