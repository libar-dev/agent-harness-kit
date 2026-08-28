import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';

/** Read one directory for discovery, treating unavailable roots as empty. */
export async function readDiscoveryDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Return paths in deterministic lexical order. */
export function sortDiscoveredPaths(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right));
}
