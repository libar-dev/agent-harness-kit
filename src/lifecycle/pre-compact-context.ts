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

function readStoredContext(value: unknown): StoredPreCompactContext | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  let createdAt: string | undefined;
  let context: string | undefined;

  for (const [key, field] of Object.entries(value)) {
    if (key === 'createdAt' && typeof field === 'string') {
      createdAt = field;
    } else if (key === 'context' && typeof field === 'string') {
      context = field;
    }
  }

  if (createdAt === undefined || context === undefined) {
    return null;
  }

  return { createdAt, context };
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
    const stored = readStoredContext(parsed);
    if (!stored) {
      return null;
    }
    const createdAtMs = Date.parse(stored.createdAt);
    if (
      !Number.isFinite(createdAtMs) ||
      Date.now() - createdAtMs > MAX_CONTEXT_AGE_MS ||
      stored.context.trim().length === 0
    ) {
      return null;
    }
    return stored.context;
  } catch {
    await unlink(path).catch(() => undefined);
    return null;
  }
}
