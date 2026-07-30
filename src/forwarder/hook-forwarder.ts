import { readFile, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HookEndpointFile,
  isCwdUnderRoots,
  isProcessAlive,
} from '../endpoint-discovery/index.js';

const DEFAULT_TIMEOUT_MS = 45_000;

interface ForwarderEvent {
  readonly hook_event_name: string;
  readonly cwd: string;
}

interface PostJsonOptions {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly payload: string;
  readonly timeoutMs: number;
}

/** Forward one stdin hook event, writing only a non-empty JSON decision. */
export async function runForwarder(): Promise<void> {
  const raw = await readStdin();
  const event = parseForwarderEvent(safeJson(raw));
  if (event === null) return;

  const endpointPath =
    process.env['AGENT_HOOK_ENDPOINT_FILE'] ??
    join(homedir(), '.claude', 'libar-cockpit', 'endpoint.json');
  const endpoint = await readEndpoint(endpointPath);
  if (endpoint === null) return;
  if (!isProcessAlive(endpoint.pid)) return;
  const canonicalCwd = await realpath(event.cwd).catch(() => event.cwd);
  if (!isCwdUnderRoots(canonicalCwd, endpoint.projectRoots)) return;

  const body = await postJson({
    host: '127.0.0.1',
    port: endpoint.port,
    path: `/hooks/${endpoint.token}/${encodeURIComponent(event.hook_event_name)}`,
    payload: raw,
    timeoutMs: getTimeoutMs(),
  });
  if (body === null) return;

  const decision = safeJson(body);
  if (isNonEmptyRecord(decision)) process.stdout.write(body);
}

/** POST JSON and return the response body only for successful HTTP responses. */
export function postJson(options: PostJsonOptions): Promise<string | null> {
  return new Promise(resolve => {
    const req = request(
      {
        host: options.host,
        port: options.port,
        path: options.path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(options.payload),
        },
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          if (
            response.statusCode === undefined ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            resolve(null);
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      }
    );

    const finishSilently = (): void => resolve(null);
    req.once('error', finishSilently);
    req.setTimeout(options.timeoutMs, () => req.destroy());
    req.end(options.payload);
  });
}

async function readEndpoint(filePath: string) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const result = HookEndpointFile.safeParse(safeJson(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
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

function parseForwarderEvent(value: unknown): ForwarderEvent | null {
  if (!isRecord(value)) return null;
  const eventName = value['hook_event_name'];
  const cwd = value['cwd'];
  if (typeof eventName !== 'string' || typeof cwd !== 'string') return null;
  return { hook_event_name: eventName, cwd };
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getTimeoutMs(): number {
  const configured = Number(process.env['AGENT_HOOK_FORWARD_TIMEOUT_MS']);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  void runForwarder()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
