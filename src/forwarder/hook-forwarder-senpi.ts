/**
 * Senpi observe-only hook forwarder (standalone asset source).
 *
 * Modeled on `hook-forwarder.ts`: reads one senpi `HookInputWire` envelope
 * from stdin (1 MiB cap) and best-effort POSTs it VERBATIM as JSON to the
 * endpoint URL configured through `SENPI_HOOK_FORWARD_URL`.
 *
 * URL policy: only `http`/`https` URLs whose host is `127.0.0.1`,
 * `localhost`, or `::1` are accepted unless
 * `SENPI_HOOK_FORWARD_ALLOW_REMOTE=1` unlocks remote hosts. Redirects are
 * never followed.
 *
 * Observe-only guarantee: this script NEVER emits gate or decision JSON to
 * stdout and ALWAYS exits 0. Unreachable endpoints, internal timeouts,
 * malformed stdin, and every other failure mode are swallowed silently.
 *
 * Bundled by the package build step (esbuild, `--target=node22`) to
 * `dist/standalone/hook-forwarder-senpi.mjs`.
 */

import { pathToFileURL } from 'node:url';

import { readBoundedTimedStdin } from '../internal/stdin.js';

/** The seven senpi hook events (vendored contract, engine 2026.8.19). */
const SENPI_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'PreCompact',
  'PostCompact',
  'Stop',
]);

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STDIN_MAX_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
]);

interface ForwardedEnvelope {
  readonly event: string;
}

/**
 * Forward one stdin senpi hook envelope to the configured endpoint.
 *
 * Observe-only guarantee: resolves without writing anything to stdout and
 * without ever throwing; the process entry point always exits 0.
 *
 * Rejects non-http(s) URLs and, unless `SENPI_HOOK_FORWARD_ALLOW_REMOTE=1`,
 * any host other than `127.0.0.1`, `localhost`, or `::1`. Stdin is capped
 * at 1 MiB; truncated or malformed envelopes fail the shape gate silently.
 */
export async function runSenpiForwarder(): Promise<void> {
  const url = process.env['SENPI_HOOK_FORWARD_URL'];
  if (url === undefined || url.trim() === '') return;
  const trimmedUrl = url.trim();
  if (!isAllowedSenpiForwardUrl(trimmedUrl)) return;

  const raw = await readStdin();
  const envelope = parseEnvelope(safeJson(raw));
  if (envelope === null) return;

  await postJson(trimmedUrl, raw, getTimeoutMs());
}

/**
 * Accept only http(s) URLs. Loopback hosts are the default; remote hosts
 * require `SENPI_HOOK_FORWARD_ALLOW_REMOTE=1`.
 */
function isAllowedSenpiForwardUrl(urlText: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (process.env['SENPI_HOOK_FORWARD_ALLOW_REMOTE'] === '1') {
    return true;
  }
  return LOOPBACK_HOSTS.has(normalizeHostname(parsed.hostname));
}

/**
 * WHATWG hostnames are usually unbracketed, but this Node reports IPv6
 * literals as `[::1]`. Strip surrounding brackets before the allowlist check.
 */
function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * POST a JSON payload and ignore the response entirely.
 *
 * Observe-only guarantee: network errors, timeouts, and non-success status
 * codes are all swallowed; nothing is written to stdout and nothing throws.
 */
async function postJson(
  url: string,
  payload: string,
  timeoutMs: number
): Promise<void> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
  } catch {
    // Observe-only: delivery is best-effort; every failure stays silent.
    return;
  }
}

async function readStdin(): Promise<string> {
  try {
    return await readBoundedTimedStdin({
      stdin: process.stdin as AsyncIterable<Buffer>,
      maxBytes: DEFAULT_STDIN_MAX_BYTES,
      timeoutMs: getTimeoutMs(),
      stderr: { write: () => undefined },
      exit: () => undefined,
      timeoutMessage: 'Timeout waiting for Senpi hook stdin input',
      createTimeoutError: () =>
        new Error('Timeout waiting for Senpi hook stdin input'),
    });
  } catch {
    // Observe-only: timeout and read failures stay silent.
    return '';
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Accept only inputs shaped like a senpi `HookInputWire` envelope: an object
 * carrying one of the seven event names (`event` primary or its snake_case
 * `hook_event_name` alias) plus a string `cwd`. Anything else returns null.
 */
function parseEnvelope(value: unknown): ForwardedEnvelope | null {
  if (!isRecord(value)) return null;
  const primary = value['event'];
  const alias = value['hook_event_name'];
  const event =
    typeof primary === 'string'
      ? primary
      : typeof alias === 'string'
        ? alias
        : undefined;
  if (event === undefined || !SENPI_HOOK_EVENTS.has(event)) return null;
  if (typeof value['cwd'] !== 'string') return null;
  return { event };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTimeoutMs(): number {
  const configured = Number(process.env['SENPI_HOOK_FORWARD_TIMEOUT_MS']);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  void runSenpiForwarder()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
