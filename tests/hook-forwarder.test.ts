import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const sourcePath = resolve('src/forwarder/hook-forwarder.ts');
const tempDirs: string[] = [];
const servers: Server[] = [];

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

describe('standalone hook forwarder', () => {
  it('relays a non-empty JSON decision verbatim', async () => {
    const decision =
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}';
    const server = await startServer((request, response) => {
      expect(request.headers['content-type']).toBe('application/json');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(decision);
    });
    const endpointPath = await writeEndpoint(serverPort(server));

    const result = await runForwarder(validEvent(), endpointPath);

    expect(result).toEqual({ code: 0, stdout: decision, stderr: '' });
  });

  it('exits silently when the endpoint file is missing', async () => {
    const dir = await createTempDir();
    await expectSilent(validEvent(), join(dir, 'missing.json'));
  });

  it('exits silently for a stale process id', async () => {
    const endpointPath = await writeEndpoint(5710, { pid: 99_999_999 });
    await expectSilent(validEvent(), endpointPath);
  });

  it('exits silently when cwd is outside the published roots', async () => {
    const endpointPath = await writeEndpoint(5710, {
      projectRoots: ['/another/project'],
    });
    await expectSilent(validEvent(), endpointPath);
  });

  it('exits silently when the endpoint refuses connections', async () => {
    const server = await startServer((_request, response) => response.end());
    const port = serverPort(server);
    await closeServer(server);
    const endpointPath = await writeEndpoint(port);
    await expectSilent(validEvent(), endpointPath);
  });

  it('exits silently for a non-success response', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(404);
      response.end('{}');
    });
    const endpointPath = await writeEndpoint(serverPort(server));
    await expectSilent(validEvent(), endpointPath);
  });

  it('exits silently when the endpoint times out', async () => {
    const server = await startServer(() => undefined);
    const endpointPath = await writeEndpoint(serverPort(server));
    await expectSilent(validEvent(), endpointPath, 20);
  });

  it('exits silently for garbage stdin', async () => {
    const endpointPath = await writeEndpoint(5710);
    await expectSilent('not json', endpointPath);
  });

  it('exits silently for an empty JSON response', async () => {
    const server = await startServer((_request, response) =>
      response.end('{}')
    );
    const endpointPath = await writeEndpoint(serverPort(server));
    await expectSilent(validEvent(), endpointPath);
  });
});

function validEvent(): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    cwd: '/repo/project/src',
  });
}

async function expectSilent(
  stdin: string,
  endpointPath: string,
  timeoutMs?: number
): Promise<void> {
  const result = await runForwarder(stdin, endpointPath, timeoutMs);
  expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
}

async function runForwarder(
  stdin: string,
  endpointPath: string,
  timeoutMs?: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', sourcePath], {
    env: {
      ...process.env,
      AGENT_HOOK_ENDPOINT_FILE: endpointPath,
      ...(timeoutMs === undefined
        ? {}
        : { AGENT_HOOK_FORWARD_TIMEOUT_MS: String(timeoutMs) }),
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

async function writeEndpoint(
  port: number,
  overrides: Partial<{
    pid: number;
    projectRoots: string[];
  }> = {}
): Promise<string> {
  const dir = await createTempDir();
  const path = join(dir, 'endpoint.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      pid: overrides.pid ?? process.pid,
      port,
      token: '0123456789abcdef0123456789abcdef',
      startedAt: new Date().toISOString(),
      projectRoots: overrides.projectRoots ?? ['/repo/project'],
    })
  );
  return path;
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-hook-forwarder-'));
  tempDirs.push(dir);
  return dir;
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
