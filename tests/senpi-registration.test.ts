import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  readFile,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildSenpiHooksRegistration,
  writeSenpiHooksConfig,
} from '../src/senpi/registration.js';
import {
  SENPI_HOOK_EVENT_NAMES,
  validateSenpiHooksConfig,
  type SenpiHookEventName,
} from '../src/senpi/settings.js';

const FORWARDER_SOURCE = resolve('src/forwarder/hook-forwarder-senpi.ts');
const FIXTURE_PATH = resolve(
  'tests/fixtures/senpi/hook-inputs/pre-tool-use.json'
);

const tempDirs: string[] = [];
const servers: Server[] = [];
let bundleDir = '';
let bundledForwarderPath = '';

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), 'senpi-forwarder-bundle-'));
  bundledForwarderPath = join(
    bundleDir,
    'dist',
    'standalone',
    'hook-forwarder-senpi.mjs'
  );
  await build({
    entryPoints: [FORWARDER_SOURCE],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundledForwarderPath,
    logLevel: 'silent',
  });
  // macOS tmpdir is symlinked (/var -> /private/var); the entry-point guard
  // compares argv[1] against import.meta.url, so both must be canonical.
  bundledForwarderPath = await realpath(bundledForwarderPath);
});

afterAll(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        server =>
          new Promise<void>(resolveClose => server.close(() => resolveClose()))
      )
  );
  await Promise.all(
    tempDirs.splice(0).map(path => rm(path, { recursive: true }))
  );
});

describe('buildSenpiHooksRegistration', () => {
  it('round-trips the full seven-event document with zero diagnostics', () => {
    const document = buildSenpiHooksRegistration(
      [...SENPI_HOOK_EVENT_NAMES],
      'node forwarder.mjs'
    );

    const result = validateSenpiHooksConfig(document);
    expect(result.diagnostics).toEqual([]);
    expect(result.executableHandlers).toHaveLength(
      SENPI_HOOK_EVENT_NAMES.length
    );
    for (const event of SENPI_HOOK_EVENT_NAMES) {
      expect(document.hooks[event]).toEqual([
        { hooks: [{ type: 'command', command: 'node forwarder.mjs' }] },
      ]);
    }
  });

  it('round-trips an event subset with zero diagnostics and preserves order', () => {
    const subset: readonly SenpiHookEventName[] = [
      'Stop',
      'PreToolUse',
      'PostCompact',
    ];
    const document = buildSenpiHooksRegistration(subset, 'observe-hook');

    expect(Object.keys(document.hooks)).toEqual([...subset]);
    const result = validateSenpiHooksConfig(document);
    expect(result.diagnostics).toEqual([]);
    expect(result.executableHandlers.map(handler => handler.event)).toEqual([
      ...subset,
    ]);
  });

  it('collapses duplicate events', () => {
    const document = buildSenpiHooksRegistration(
      ['Stop', 'Stop'],
      'observe-hook'
    );

    expect(Object.keys(document.hooks)).toEqual(['Stop']);
    expect(validateSenpiHooksConfig(document).diagnostics).toEqual([]);
  });

  it('round-trips an empty event list with zero diagnostics', () => {
    const document = buildSenpiHooksRegistration([], 'observe-hook');

    expect(document.hooks).toEqual({});
    expect(validateSenpiHooksConfig(document)).toEqual({
      executableHandlers: [],
      diagnostics: [],
    });
  });

  it('rejects a blank command', () => {
    expect(() => buildSenpiHooksRegistration(['Stop'], '  ')).toThrow(
      RangeError
    );
  });
});

describe('writeSenpiHooksConfig', () => {
  it('atomically writes the document and leaves no temp files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'senpi-registration-'));
    tempDirs.push(dir);
    const target = join(dir, 'nested', 'hooks.json');
    const document = buildSenpiHooksRegistration(
      ['PreToolUse', 'Stop'],
      'observe-hook'
    );

    await writeSenpiHooksConfig(target, document);

    const written: unknown = JSON.parse(await readFile(target, 'utf8'));
    expect(written).toEqual(document);
    expect(validateSenpiHooksConfig(written).diagnostics).toEqual([]);
    expect(await readdir(dir)).toEqual(['nested']);
    expect(await readdir(join(dir, 'nested'))).toEqual(['hooks.json']);
  });

  it('propagates write failures and leaves no temp files behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'senpi-registration-'));
    tempDirs.push(dir);
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'occupied', 'utf8');
    // The parent "directory" is a regular file, so mkdir/write must fail.
    const target = join(blocker, 'hooks.json');

    await expect(
      writeSenpiHooksConfig(
        target,
        buildSenpiHooksRegistration(['Stop'], 'observe-hook')
      )
    ).rejects.toThrow();

    expect(await readdir(dir)).toEqual(['blocker']);
  });
});

describe('standalone senpi hook forwarder', () => {
  it('POSTs the fixture envelope to the endpoint and exits 0 silently', async () => {
    const envelope = await readFile(FIXTURE_PATH, 'utf8');
    const captured: { body: string; contentType: string | undefined }[] = [];
    const server = await startServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        captured.push({
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: request.headers['content-type'],
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });

    const result = await runForwarder(
      envelope,
      `http://127.0.0.1:${serverPort(server)}/senpi-hooks`
    );

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.contentType).toBe('application/json');
    // Misleading-success guard: the captured body must BE the envelope.
    expect(JSON.parse(captured[0]?.body ?? '')).toEqual(JSON.parse(envelope));
    expect((captured[0]?.body ?? '').trim()).toBe(envelope.trim());
  });

  it('exits 0 silently and quickly when the endpoint refuses connections', async () => {
    const server = await startServer((_request, response) => response.end());
    const port = serverPort(server);
    await closeServer(server);

    const startedAt = Date.now();
    const result = await runForwarder(
      await readFile(FIXTURE_PATH, 'utf8'),
      `http://127.0.0.1:${port}/senpi-hooks`
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('applies the internal timeout bound against a black-hole endpoint', async () => {
    const server = await startServer(() => undefined);

    const startedAt = Date.now();
    const result = await runForwarder(
      await readFile(FIXTURE_PATH, 'utf8'),
      `http://127.0.0.1:${serverPort(server)}/senpi-hooks`,
      250
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('exits 0 silently and sends nothing for non-JSON stdin', async () => {
    let requestCount = 0;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      response.end('{}');
    });

    const result = await runForwarder(
      'not json',
      `http://127.0.0.1:${serverPort(server)}/senpi-hooks`
    );

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(requestCount).toBe(0);
  });

  it('exits 0 silently and sends nothing for a non-envelope JSON object', async () => {
    let requestCount = 0;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      response.end('{}');
    });

    const result = await runForwarder(
      JSON.stringify({ hook_event_name: 'SessionEnd', cwd: '/project' }),
      `http://127.0.0.1:${serverPort(server)}/senpi-hooks`
    );

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(requestCount).toBe(0);
  });
});

async function runForwarder(
  stdin: string,
  url: string,
  timeoutMs?: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [bundledForwarderPath], {
    env: {
      ...process.env,
      SENPI_HOOK_FORWARD_URL: url,
      ...(timeoutMs === undefined
        ? {}
        : { SENPI_HOOK_FORWARD_TIMEOUT_MS: String(timeoutMs) }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(stdin);
  const code = await new Promise<number | null>(resolveClose => {
    child.once('close', resolveClose);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<Server> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function closeServer(server: Server): Promise<void> {
  const index = servers.indexOf(server);
  if (index !== -1) servers.splice(index, 1);
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

function serverPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an IP server address');
  }
  return address.port;
}
