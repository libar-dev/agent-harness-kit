import { open } from 'node:fs/promises';

import { hasErrorCode } from './marker-store.js';

/** Outcome of a FileHandle read that never stats or loads past `maxBytes`. */
export type BoundedFileReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'oversize' }
  | { readonly kind: 'unreadable' };

/**
 * Read a UTF-8 file using a FileHandle, stopping at `maxBytes`.
 *
 * The function never stats and never calls `readFile`. It reads at most
 * `maxBytes + 1` bytes so an oversize file is detected without loading the
 * remainder. Short reads are looped until EOF or the bound.
 *
 * @param path - File to read.
 * @param maxBytes - Inclusive UTF-8 byte cap for a successful read.
 * @returns Missing, ok text, oversize, or unreadable — contents errors do not throw.
 */
export async function readUtf8FileBounded(
  path: string,
  maxBytes: number
): Promise<BoundedFileReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a safe non-negative integer');
  }
  let file;
  try {
    file = await open(path, 'r');
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) return { kind: 'missing' };
    return { kind: 'unreadable' };
  }
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < maxBytes + 1) {
      const { bytesRead } = await file.read(
        buffer,
        total,
        maxBytes + 1 - total,
        total
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) return { kind: 'oversize' };
    return { kind: 'ok', text: buffer.subarray(0, total).toString('utf8') };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    await file.close();
  }
}
