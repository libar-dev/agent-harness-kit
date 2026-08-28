import { watch as watchFs } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect } from 'vitest';
import type { GrokSessionTailResult } from '../src/grok/processing/tail.js';
/** Test fixture contract consumed by bounded cursor regression cases. */
export const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'grok'
);
/** Test fixture contract consumed by bounded cursor regression cases. */
export const OVERSIZE_PREFIX_BYTES = 32 * 1024 * 1024;
/** Test fixture contract consumed by bounded cursor regression cases. */
export const LINE_CAP = 10_000;
/** Test fixture contract consumed by bounded cursor regression cases. */
export const ONE_MIB = 1024 * 1024;
/** Test fixture contract consumed by bounded cursor regression cases. */
export const EXACT_MIB_CHAIN = 40;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(path => rm(path, { recursive: true, force: true }))
  );
});

/** Test fixture contract consumed by bounded cursor regression cases. */
export async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export function updateLine(
  timestamp: number,
  text: string,
  messageId: string
): string {
  return `${JSON.stringify({
    timestamp,
    method: 'session/update',
    params: {
      sessionId: 'session-tail',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId,
        content: { type: 'text', text },
        _meta: { promptIndex: 0 },
      },
    },
  })}\n`;
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export function senpiHeader(): string {
  return `${JSON.stringify({
    type: 'session',
    version: 3,
    id: 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0007',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/Users/fixture-user/projects/demo',
  })}\n`;
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export function senpiMessage(
  id: string,
  parentId: string | null,
  text: string
): string {
  return `${JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: 1704067201000,
    },
  })}\n`;
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export function senpiExactMiBMessage(
  id: string,
  parentId: string | null
): string {
  const empty = senpiMessage(id, parentId, '');
  const pad = ONE_MIB - Buffer.byteLength(empty);
  if (pad < 0) throw new Error('Senpi message header exceeds 1 MiB');
  const line = senpiMessage(id, parentId, 'x'.repeat(pad));
  if (Buffer.byteLength(line) !== ONE_MIB) {
    throw new Error('Senpi message is not exactly 1 MiB');
  }
  return line;
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export async function writeSenpiExactMiBChain(
  path: string,
  count: number
): Promise<void> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(senpiHeader());
    let parent: string | null = null;
    const batch: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = `m${String(index).padStart(5, '0')}`;
      batch.push(senpiExactMiBMessage(id, parent));
      parent = id;
      if (batch.length === 4) {
        await handle.writeFile(batch.join(''));
        batch.length = 0;
      }
    }
    if (batch.length > 0) await handle.writeFile(batch.join(''));
  } finally {
    await handle.close();
  }
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export function missingParentCodes(
  diagnostics: readonly { readonly code: string }[]
): readonly string[] {
  return diagnostics
    .filter(item => item.code === 'missing_parent')
    .map(item => item.code);
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export async function writeManyLines(
  path: string,
  count: number,
  lineAt: (index: number) => string
): Promise<void> {
  const handle = await writeFile(path, '', { flag: 'w' }).then(() =>
    import('node:fs/promises').then(fs => fs.open(path, 'a'))
  );
  try {
    const batch: string[] = [];
    for (let index = 0; index < count; index += 1) {
      batch.push(lineAt(index));
      if (batch.length === 250) {
        await handle.writeFile(batch.join(''));
        batch.length = 0;
      }
    }
    if (batch.length > 0) await handle.writeFile(batch.join(''));
  } finally {
    await handle.close();
  }
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export async function writeOversizedThenRecord(
  path: string,
  record: string
): Promise<void> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'w');
  try {
    const chunk = Buffer.alloc(1024 * 1024, 0x78);
    for (
      let written = 0;
      written < OVERSIZE_PREFIX_BYTES;
      written += chunk.byteLength
    ) {
      await handle.write(chunk);
    }
    await handle.write(Buffer.from(record));
  } finally {
    await handle.close();
  }
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export async function grokSession(root: string, name: string): Promise<string> {
  const session = join(root, name);
  await mkdir(session);
  await Promise.all([
    copyFile(
      join(fixturesDir, 'updates.sample.jsonl'),
      join(session, 'updates.jsonl')
    ),
    copyFile(
      join(fixturesDir, 'events.sample.jsonl'),
      join(session, 'events.jsonl')
    ),
  ]);
  return session;
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export async function markerFile(
  markerDir: string,
  suffix: string
): Promise<string> {
  const names = (await readdir(markerDir)).filter(name =>
    name.endsWith(suffix)
  );
  expect(names).toHaveLength(1);
  const name = names[0];
  if (name === undefined) throw new Error('marker file was not created');
  return join(markerDir, name);
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export function grokUpdatesPending(result: GrokSessionTailResult): {
  readonly kind: 'discarding_oversized';
  readonly byteStart: number;
} | null {
  const source = result.checkpoint.sources.find(
    entry => entry.sourceKind === 'updates'
  );
  return source?.cursor?.pending ?? null;
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export async function waitForFsEvent(
  path: string,
  action: () => Promise<void>
): Promise<void> {
  const event = new Promise<void>((resolve, reject) => {
    const signal = AbortSignal.timeout(5_000);
    const watcher = watchFs(path, { signal }, () => {
      watcher.close();
      resolve();
    });
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
    watcher.on('error', reject);
  });
  await action();
  await event;
}

/** Test fixture contract consumed by bounded cursor regression cases. */
export async function nextWithTimeout(
  iterator: AsyncIterator<GrokSessionTailResult>
): Promise<IteratorYieldResult<GrokSessionTailResult>> {
  const result = await new Promise<IteratorResult<GrokSessionTailResult, void>>(
    (resolve, reject) => {
      const signal = AbortSignal.timeout(8_000);
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
      void iterator.next().then(resolve, reject);
    }
  );
  if (result.done) throw new Error('watch ended before yielding a batch');
  return result;
}
