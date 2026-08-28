import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ownedSources = [
  'src/grok/processing/tail.ts',
  'src/grok/processing/tail-marker.ts',
  'src/grok/processing/tail-order.ts',
  'src/grok/processing/tail-parse.ts',
  'src/grok/processing/tail-result.ts',
  'src/grok/processing/tail-run.ts',
  'src/grok/processing/tail-types.ts',
  'src/grok/processing/tail-watch.ts',
  'src/internal/bounded-file-read.ts',
  'src/internal/incremental.ts',
  'src/internal/jsonl-cursor.ts',
  'src/internal/jsonl-cursor-scan.ts',
  'src/internal/jsonl-cursor-types.ts',
  'src/internal/senpi-checkpoint-test-seam.ts',
  'src/senpi/processing/accepted-graph.ts',
  'src/senpi/processing/checkpoint.ts',
  'src/senpi/processing/checkpoint-carrier.ts',
  'src/senpi/processing/checkpoint-internal-types.ts',
  'src/senpi/processing/checkpoint-path.ts',
  'src/senpi/processing/checkpoint-read.ts',
  'src/senpi/processing/checkpoint-types.ts',
  'src/senpi/processing/checkpoint-write.ts',
  'src/senpi/processing/tail.ts',
  'src/senpi/processing/tail-parse.ts',
  'src/senpi/processing/tail-project.ts',
  'src/senpi/processing/tail-projection-result.ts',
  'src/senpi/processing/tail-rebuild.ts',
  'src/senpi/processing/tail-result.ts',
  'src/senpi/processing/tail-resume.ts',
  'src/senpi/processing/tail-run.ts',
  'src/senpi/processing/tail-run-support.ts',
  'src/senpi/processing/tail-types.ts',
  'src/senpi/processing/watch.ts',
  'tests/adapter-scan-cap-continuation-1-cases.ts',
  'tests/adapter-scan-cap-continuation-2-cases.ts',
  'tests/adapter-scan-cap-continuation-3-cases.ts',
  'tests/adapter-scan-cap-continuation-4-cases.ts',
  'tests/adapter-scan-cap-utils.ts',
  'tests/internal-jsonl-cursor-1-cases.ts',
  'tests/internal-jsonl-cursor-2-cases.ts',
  'tests/internal-jsonl-cursor-3-cases.ts',
  'tests/internal-jsonl-cursor-4-cases.ts',
  'tests/internal-jsonl-cursor-utils.ts',
  'tests/senpi-checkpoint-utils.ts',
  'tests/senpi-internal-state-utils.ts',
  'tests/senpi-marker-graph-1-cases.ts',
  'tests/senpi-marker-graph-2-cases.ts',
  'tests/senpi-marker-graph-3-cases.ts',
  'tests/senpi-marker-graph-utils.ts',
  'tests/senpi-watch-clock-utils.ts',
  'tests/senpi-watch-utils.ts',
] as const;

function isExported(statement: ts.Statement): boolean {
  return (
    ts.isExportDeclaration(statement) ||
    (ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
        true)
  );
}

function hasDirectJsdoc(
  source: ts.SourceFile,
  statement: ts.Statement
): boolean {
  const ranges = ts.getLeadingCommentRanges(
    source.text,
    statement.getFullStart()
  );
  const last = ranges?.at(-1);
  return (
    last !== undefined &&
    source.text.slice(last.pos, last.end).startsWith('/**') &&
    source.text.slice(last.end, statement.getStart(source)).trim().length === 0
  );
}

describe('todo 5 export documentation', () => {
  it('attaches JSDoc directly to every owned export declaration', async () => {
    const missing: string[] = [];
    let covered = 0;
    for (const path of ownedSources) {
      const text = await readFile(join(process.cwd(), path), 'utf8');
      const source = ts.createSourceFile(
        path,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      for (const statement of source.statements) {
        if (!isExported(statement)) continue;
        const line =
          source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
        if (hasDirectJsdoc(source, statement)) covered += 1;
        else missing.push(`${path}:${String(line)}`);
      }
    }
    expect(missing).toEqual([]);
    expect(covered).toBe(236);
  });
});
