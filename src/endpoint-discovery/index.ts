import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import {
  HookEndpointFile,
  type HookEndpointFileData,
  DEFAULT_ENDPOINT_FILE_RELPATH,
} from './schema.js';

export {
  HookEndpointFile,
  type HookEndpointFileData,
  DEFAULT_ENDPOINT_FILE_RELPATH,
};

/** Read and validate a hook endpoint file, returning null on any failure. */
export async function readHookEndpointFile(
  filePath: string
): Promise<HookEndpointFileData | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = HookEndpointFile.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Report whether a process exists or cannot be inspected due to permissions. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isErrorWithCode(error) && error.code === 'EPERM';
  }
}

/** Check whether cwd is equal to or nested below one of the supplied roots. */
export function isCwdUnderRoots(
  cwd: string,
  roots: readonly string[]
): boolean {
  const useWindowsRules = isWindowsStylePath(cwd);
  const pathApi = useWindowsRules ? win32 : posix;
  const normalizedCwd = normalizeComparablePath(cwd, useWindowsRules);

  return roots.some(root => {
    if (isWindowsStylePath(root) !== useWindowsRules) return false;
    const normalizedRoot = normalizeComparablePath(root, useWindowsRules);
    const relative = pathApi.relative(normalizedRoot, normalizedCwd);
    return (
      relative === '' ||
      (relative !== '..' &&
        !relative.startsWith(`..${pathApi.sep}`) &&
        !pathApi.isAbsolute(relative))
    );
  });
}

/** Build the loopback hook URL for an event. */
export function buildHookUrl(
  endpoint: HookEndpointFileData,
  eventName: string
): string {
  return `http://127.0.0.1:${String(endpoint.port)}/hooks/${endpoint.token}/${encodeURIComponent(eventName)}`;
}

function isWindowsStylePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.includes('\\');
}

function normalizeComparablePath(value: string, windows: boolean): string {
  const pathApi = windows ? win32 : posix;
  const normalized = pathApi.resolve(value);
  return windows ? normalized.toLowerCase() : normalized;
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}
