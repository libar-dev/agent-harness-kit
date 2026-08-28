import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
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
 * Containment follows symlinks: the candidate and each root are walked to
 * their deepest existing ancestor, `realpath`'d, then rejoined with any
 * not-yet-created remainder before the suffix check.
 *
 * @param markerDir - Caller-supplied marker directory.
 * @param options - Explicit roots, optional env fallback, and empty-roots message.
 * @returns Absolute marker directory path (lexical `resolve`, not realpath).
 * @throws When no usable root exists or `markerDir` is outside every root.
 */
export function resolveAllowedMarkerDir(
  markerDir: string,
  options: ResolveAllowedMarkerDirOptions
): string {
  const resolvedDir = resolve(markerDir);
  const roots = collectAllowedMarkerRoots(options);
  if (roots.length === 0) {
    throw new Error(options.emptyRootsMessage);
  }
  if (!roots.some(root => isWithinPathResolved(resolvedDir, root))) {
    throw new Error(outsideAllowedRootsMessage(resolvedDir));
  }
  return resolvedDir;
}

/**
 * Re-verify that an already-created marker directory still sits inside
 * allowed roots after symlink resolution.
 *
 * Use after `mkdir` so a directory swapped for an outward symlink between
 * {@link resolveAllowedMarkerDir} and the write is rejected at the choke
 * point.
 *
 * @param markerDir - Marker directory that should now exist.
 * @param options - Same roots / env fallback used at resolve time.
 * @throws When no usable root exists, the directory cannot be realpath'd,
 *   or its real path is outside every realpath-walked root.
 */
export function assertMarkerDirStillAllowed(
  markerDir: string,
  options: ResolveAllowedMarkerDirOptions
): void {
  const resolvedDir = resolve(markerDir);
  const roots = collectAllowedMarkerRoots(options);
  if (roots.length === 0) {
    throw new Error(options.emptyRootsMessage);
  }
  let realDir: string;
  try {
    realDir = realpathSync(resolvedDir);
  } catch {
    throw new Error(outsideAllowedRootsMessage(resolvedDir));
  }
  if (
    !roots.some(root => {
      try {
        return isWithinPath(realDir, resolveThroughExistingAncestor(root));
      } catch {
        return false;
      }
    })
  ) {
    throw new Error(outsideAllowedRootsMessage(resolvedDir));
  }
}

/**
 * True when `child` equals `parent` or is nested under it.
 *
 * Lexical only: does not follow symlinks. Callers that need symlink-aware
 * containment should use {@link isWithinPathResolved}.
 *
 * @param child - Absolute candidate path.
 * @param parent - Absolute allowed root.
 */
export function isWithinPath(child: string, parent: string): boolean {
  const parentPrefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(parentPrefix);
}

/**
 * True when the symlink-resolved `child` equals the symlink-resolved
 * `parent` or is nested under it.
 *
 * Walks each path up to its deepest existing ancestor (`lstat`),
 * `realpath`s that ancestor, and rejoins any not-yet-created remainder
 * before applying the same suffix rule as {@link isWithinPath}. Fail-closed
 * on `realpath` errors (broken symlinks, inaccessible ancestors).
 *
 * @param child - Candidate path, absolute or relative.
 * @param parent - Allowed root, absolute or relative.
 */
export function isWithinPathResolved(child: string, parent: string): boolean {
  try {
    return isWithinPath(
      resolveThroughExistingAncestor(child),
      resolveThroughExistingAncestor(parent)
    );
  } catch {
    return false;
  }
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
 * When `allowed` is provided, the destination directory is re-verified
 * after `mkdir` so a symlink swap cannot escape the allow-list.
 *
 * @param path - Destination marker path.
 * @param value - JSON-serializable payload.
 * @param allowed - Optional roots used to re-verify the destination dir.
 */
export async function writePrivateJson(
  path: string,
  value: unknown,
  allowed?: ResolveAllowedMarkerDirOptions
): Promise<void> {
  const markerDir = dirname(path);
  await mkdir(markerDir, { recursive: true, mode: 0o700 });
  if (allowed !== undefined) {
    assertMarkerDirStillAllowed(markerDir, allowed);
  }
  const temporaryPath = join(
    markerDir,
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

function collectAllowedMarkerRoots(
  options: ResolveAllowedMarkerDirOptions
): readonly string[] {
  return options.allowedMarkerRoots !== undefined
    ? normalizeAllowedMarkerRoots(options.allowedMarkerRoots)
    : options.rootsEnvVar !== undefined
      ? parseAllowedMarkerRoots(options.rootsEnvVar)
      : [];
}

function outsideAllowedRootsMessage(resolvedDir: string): string {
  return `Marker directory '${resolvedDir}' is outside allowed marker roots`;
}

/**
 * Resolve `path` through its deepest existing ancestor, then rejoin any
 * not-yet-created remainder. `lstat` treats a symlink as existing so
 * `realpath` can reveal an outward target instead of walking past it.
 */
function resolveThroughExistingAncestor(path: string): string {
  const resolved = resolve(path);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      lstatSync(current);
      break;
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
  const realExisting = realpathSync(current);
  return missing.length === 0 ? realExisting : join(realExisting, ...missing);
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
