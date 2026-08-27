import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';

/**
 * Options that gate a custom marker directory against allowed roots.
 *
 * When `allowedMarkerRoots` is defined (including `[]`), it wins. Otherwise,
 * when `rootsEnvVar` is set, that environment variable is parsed as a
 * path-delimited allow-list. Either way, an empty usable root set or a
 * directory outside every root rejects the call.
 */
export type ResolveAllowedMarkerDirOptions = {
  readonly allowedMarkerRoots?: readonly string[] | undefined;
  readonly rootsEnvVar?: string | undefined;
  readonly emptyRootsMessage: string;
};

/**
 * SHA-256 hex digest of a resolved path, used as `sessionPathDigest` and in
 * marker filenames.
 *
 * @param path - Absolute or relative path identity to digest.
 * @returns Lowercase hex digest.
 */
export function createMarkerPathDigest(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex');
}

/**
 * Sanitize a filename token for use inside a marker basename.
 *
 * @param raw - Untrusted basename fragment.
 * @returns A filesystem-safe token, or `session` when empty/dot-only.
 */
export function sanitizeMarkerBase(raw: string): string {
  const sanitized = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized.length === 0 || sanitized === '.' || sanitized === '..'
    ? 'session'
    : sanitized;
}

/**
 * Resolve a custom marker directory only when it falls inside an allowed root.
 *
 * @param markerDir - Caller-supplied marker directory.
 * @param options - Explicit roots, optional env fallback, and empty-roots message.
 * @returns Absolute marker directory path.
 * @throws When no usable root exists or `markerDir` is outside every root.
 */
export function resolveAllowedMarkerDir(
  markerDir: string,
  options: ResolveAllowedMarkerDirOptions
): string {
  const resolvedDir = resolve(markerDir);
  const roots =
    options.allowedMarkerRoots !== undefined
      ? normalizeAllowedMarkerRoots(options.allowedMarkerRoots)
      : options.rootsEnvVar !== undefined
        ? parseAllowedMarkerRoots(options.rootsEnvVar)
        : [];
  if (roots.length === 0) {
    throw new Error(options.emptyRootsMessage);
  }
  if (!roots.some(root => isWithinPath(resolvedDir, root))) {
    throw new Error(
      `Marker directory '${resolvedDir}' is outside allowed marker roots`
    );
  }
  return resolvedDir;
}

/**
 * True when `child` equals `parent` or is nested under it.
 *
 * @param child - Absolute candidate path.
 * @param parent - Absolute allowed root.
 */
export function isWithinPath(child: string, parent: string): boolean {
  const parentPrefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(parentPrefix);
}

/**
 * True when `error` carries a Node-style `code` string equal to `code`.
 *
 * @param error - Caught value.
 * @param code - Expected errno code (for example `EEXIST`).
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/**
 * Atomically write JSON under a private directory (mode `0o700`).
 *
 * Creates an `O_EXCL` temp file at mode `0o600`, writes pretty-printed JSON,
 * `fsync`s, then renames into place. Temp litter is removed on failure.
 *
 * @param path - Destination marker path.
 * @param value - JSON-serializable payload.
 */
export async function writePrivateJson(
  path: string,
  value: unknown
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`
  );
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function normalizeAllowedMarkerRoots(
  roots: readonly string[]
): readonly string[] {
  return roots
    .map(root => root.trim())
    .filter(root => root.length > 0)
    .map(root => resolve(root));
}

function parseAllowedMarkerRoots(envVar: string): readonly string[] {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(delimiter)
    .map(root => root.trim())
    .filter(root => root.length > 0)
    .map(root => resolve(root));
}
