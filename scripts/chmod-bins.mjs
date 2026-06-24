// Cross-platform replacement for `chmod 755 dist/cli/*.js`.
//
// `prepare` runs `build` on every `pnpm install` (including git installs), so
// the executable-bit step must not fail on platforms without `chmod` (Windows).
// We chmod each CLI entry to 0o755 inside a per-file try/catch, making the step
// a silent no-op when the file is missing or the OS does not support it.
import { chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const distCliDir = resolve(scriptDir, '..', 'dist', 'cli');

const binaries = ['export-sessions.js', 'tail-session.js'];

for (const binary of binaries) {
  try {
    chmodSync(resolve(distCliDir, binary), 0o755);
  } catch {
    // No-op: Windows lacks POSIX permission bits, and the file may be absent
    // in partial builds. Either way this should never block the build.
    void 0;
  }
}
