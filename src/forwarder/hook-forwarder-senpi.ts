/**
 * Senpi observe-only hook forwarder (standalone asset source).
 *
 * Modeled on `hook-forwarder.ts`: reads one senpi `HookInputWire` envelope
 * from stdin and best-effort POSTs it VERBATIM as JSON to the endpoint URL
 * configured through the `SENPI_HOOK_FORWARD_URL` environment variable.
 *
 * Observe-only guarantee: this script NEVER emits gate or decision JSON to
 * stdout and ALWAYS exits 0. Unreachable endpoints, internal timeouts,
 * malformed stdin, and every other failure mode are swallowed silently.
 *
 * Bundled by the package build step (esbuild, `--target=node22`) to
 * `dist/standalone/hook-forwarder-senpi.mjs`.
 */

import { pathToFileURL } from 'node:url';

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

interface ForwardedEnvelope {
  readonly event: string;
}

/**
 * Forward one stdin senpi hook envelope to the configured endpoint.
 *
 * Observe-only guarantee: resolves without writing anything to stdout and
 * without ever throwing; the process entry point always exits 0.
 */
export async function runSenpiForwarder(): Promise<void> {
  const url = process.env['SENPI_HOOK_FORWARD_URL'];
  if (url === undefined || url.trim() === '') return;

  const raw = await readStdin();
  const envelope = parseEnvelope(safeJson(raw));
  if (envelope === null) return;

  await postJson(url, raw, getTimeoutMs());
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
  } catch {
    // Observe-only: delivery is best-effort; every failure stays silent.
    return;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
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
