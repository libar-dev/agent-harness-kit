import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_CONTEXT_AGE_MS = 60 * 60 * 1000;

interface StoredPreCompactContext {
  createdAt: string;
  context: string;
}

function getPreCompactContextPath(sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return join(tmpdir(), `claude-pre-compact-${key}.json`);
}

/** Persist context for injection after a compact-triggered session restart. */
export async function savePreCompactContext(
  sessionId: string,
  context: string
): Promise<void> {
  const stored: StoredPreCompactContext = {
    createdAt: new Date().toISOString(),
    context,
  };
  await writeFile(
    getPreCompactContextPath(sessionId),
    JSON.stringify(stored),
    'utf-8'
  );
}

/** Consume fresh context saved before compaction, removing it after reading. */
export async function consumePreCompactContext(
  sessionId: string
): Promise<string | null> {
  const path = getPreCompactContextPath(sessionId);
  try {
    const raw = await readFile(path, 'utf-8');
    await unlink(path).catch(() => undefined);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const createdAt = Reflect.get(parsed, 'createdAt');
    const context = Reflect.get(parsed, 'context');
    if (typeof createdAt !== 'string' || typeof context !== 'string') return null;
    const createdAtMs = Date.parse(createdAt);
    if (
      !Number.isFinite(createdAtMs) ||
      Date.now() - createdAtMs > MAX_CONTEXT_AGE_MS ||
      context.trim().length === 0
    ) {
      return null;
    }
    return context;
  } catch {
    await unlink(path).catch(() => undefined);
    return null;
  }
}
