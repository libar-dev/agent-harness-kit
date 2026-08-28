import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

async function declaration(path: string): Promise<string> {
  return readFile(join(process.cwd(), 'dist', path), 'utf8');
}

describe('todo 5 public declaration surface', () => {
  it('exposes only the approved shared cursor additions', async () => {
    const cursor = await declaration('internal/jsonl-cursor-types.d.ts');
    expect(cursor).toContain(
      'readonly pending?: JsonlOversizedPending | null;'
    );
    expect(cursor).toContain('readonly scanStatus: JsonlScanStatus;');
    expect(cursor).toContain('readonly scannedBytes: number;');
    expect(cursor).toContain('readonly scannedLines: number;');
    expect(cursor).toContain('readonly maxScanBytes?: number;');
    expect(cursor).toContain('readonly maxScanLines?: number;');
  });

  it('exposes approved todo 6 fields without pre-landing todo 7', async () => {
    const [tail, checkpoint, barrel] = await Promise.all([
      declaration('senpi/processing/tail-types.d.ts'),
      declaration('senpi/processing/checkpoint-types.d.ts'),
      declaration('senpi/processing/index.d.ts'),
    ]);
    for (const required of [
      'readonly maxScanBytes?: number;',
      'readonly maxScanLines?: number;',
      'readonly maxResultBytes?: number;',
      'readonly maxResultRecords?: number;',
      'export interface SenpiTailPosition',
      'readonly scanStatus: JsonlScanStatus;',
      'readonly scannedBytes: number;',
      'readonly scannedLines: number;',
      'readonly previousPosition: SenpiTailPosition;',
      'readonly nextPosition: SenpiTailPosition;',
      'readonly moved: boolean;',
    ]) {
      expect(tail).toContain(required);
    }
    for (const forbidden of [
      'maxRebuildBytes',
      'maxRebuildLines',
      'continuation_deferred',
      'budgetBytes',
      'budgetLines',
      'remedies',
      'checkpointStatus',
    ]) {
      expect(tail).not.toContain(forbidden);
    }
    for (const forbidden of [
      'acceptedEntries',
      'projectedRecordCount',
      'readonly rebuild',
      'readonly pending',
    ]) {
      expect(checkpoint).not.toContain(forbidden);
    }
    expect(barrel).not.toContain('tailSenpiSessionInternal');
    expect(barrel).not.toContain('watchSenpiSessionInternal');
    expect(barrel).not.toContain('InternalSenpi');
  });
});
