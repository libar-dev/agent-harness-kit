import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSenpiForwarder } from '../src/forwarder/hook-forwarder-senpi.js';

const ONE_MIB = 1024 * 1024;
const TWO_MIB = 2 * ONE_MIB;

const servers: Server[] = [];
const originalStdinDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'stdin'
);

afterEach(async () => {
  restoreStdin();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map(
        server =>
          new Promise<void>(resolveClose => server.close(() => resolveClose()))
      )
  );
});

describe('senpi hook forwarder URL policy', () => {
  it('POSTs a valid envelope to a 127.0.0.1 loopback URL', async () => {
    const captured: string[] = [];
    const server = await startServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        captured.push(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200);
        response.end('{}');
      });
    });
    const envelope = validEnvelope();
    installStdin(envelope);
    vi.stubEnv(
      'SENPI_HOOK_FORWARD_URL',
      `http://127.0.0.1:${serverPort(server)}/senpi-hooks`
    );

    await runSenpiForwarder();

    expect(captured).toEqual([envelope]);
  });

  it('accepts localhost and [::1] loopback hosts (fetch spy)', async () => {
    const fetchSpy = spyFetch();
    const envelope = validEnvelope();

    installStdin(envelope);
    vi.stubEnv('SENPI_HOOK_FORWARD_URL', 'http://localhost:9/senpi-hooks');
    await runSenpiForwarder();

    installStdin(envelope);
    vi.stubEnv('SENPI_HOOK_FORWARD_URL', 'http://[::1]:9/senpi-hooks');
    await runSenpiForwarder();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const loopbackCalls = fetchCalls(fetchSpy);
    expect(fetchUrl(loopbackCalls[0])).toBe('http://localhost:9/senpi-hooks');
    expect(fetchUrl(loopbackCalls[1])).toBe('http://[::1]:9/senpi-hooks');
  });

  it('rejects a remote host by default and never POSTs (fetch spy)', async () => {
    const fetchSpy = spyFetch();
    installStdin(validEnvelope());
    vi.stubEnv('SENPI_HOOK_FORWARD_URL', 'https://example.com/senpi-hooks');

    await runSenpiForwarder();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs exactly once to a remote host when SENPI_HOOK_FORWARD_ALLOW_REMOTE=1 (fetch spy)', async () => {
    const fetchSpy = spyFetch();
    const envelope = validEnvelope();
    installStdin(envelope);
    vi.stubEnv('SENPI_HOOK_FORWARD_URL', 'https://example.com/senpi-hooks');
    vi.stubEnv('SENPI_HOOK_FORWARD_ALLOW_REMOTE', '1');

    await runSenpiForwarder();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const remoteCall = fetchCalls(fetchSpy)[0];
    expect(fetchUrl(remoteCall)).toBe('https://example.com/senpi-hooks');
    expect(fetchInit(remoteCall)).toMatchObject({
      method: 'POST',
      body: envelope,
      redirect: 'error',
    });
  });

  it('does not treat SENPI_HOOK_FORWARD_ALLOW_REMOTE=true as the opt-out', async () => {
    const fetchSpy = spyFetch();
    installStdin(validEnvelope());
    vi.stubEnv('SENPI_HOOK_FORWARD_URL', 'https://example.com/senpi-hooks');
    vi.stubEnv('SENPI_HOOK_FORWARD_ALLOW_REMOTE', 'true');

    await runSenpiForwarder();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) scheme such as ftp:// (fetch spy)', async () => {
    const fetchSpy = spyFetch();
    installStdin(validEnvelope());
    vi.stubEnv('SENPI_HOOK_FORWARD_URL', 'ftp://127.0.0.1/senpi-hooks');

    await runSenpiForwarder();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a garbage URL, an empty env var, and unbracketed IPv6 (fetch spy)', async () => {
    const fetchSpy = spyFetch();
    const envelope = validEnvelope();

    installStdin(envelope);
    vi.stubEnv('SENPI_HOOK_FORWARD_URL', 'not a url');
    await runSenpiForwarder();

    installStdin(envelope);
    vi.stubEnv('SENPI_HOOK_FORWARD_URL', '   ');
    await runSenpiForwarder();

    installStdin(envelope);
    vi.stubEnv('SENPI_HOOK_FORWARD_URL', 'http://::1/senpi-hooks');
    await runSenpiForwarder();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('senpi hook forwarder redirect refusal', () => {
  it('does not re-POST when the loopback receiver answers 302', async () => {
    const paths: string[] = [];
    const server = await startServer((request, response) => {
      paths.push(request.url ?? '');
      if (request.url === '/first') {
        response.writeHead(302, {
          Location: '/second',
        });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end('{}');
    });
    installStdin(validEnvelope());
    vi.stubEnv(
      'SENPI_HOOK_FORWARD_URL',
      `http://127.0.0.1:${serverPort(server)}/first`
    );

    await runSenpiForwarder();

    expect(paths).toEqual(['/first']);
  });
});

describe('senpi hook forwarder stdin cap and envelope gate', () => {
  it('caps a 2 MiB stdin at 1 MiB and does not POST the truncated prefix', async () => {
    let requestCount = 0;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200);
      response.end('{}');
    });
    const payload = envelopeOfBytes(TWO_MIB);
    installStdinChunks([
      Buffer.from(payload.slice(0, ONE_MIB), 'utf8'),
      Buffer.from(payload.slice(ONE_MIB), 'utf8'),
    ]);
    vi.stubEnv(
      'SENPI_HOOK_FORWARD_URL',
      `http://127.0.0.1:${serverPort(server)}/senpi-hooks`
    );

    await runSenpiForwarder();

    expect(Buffer.byteLength(payload, 'utf8')).toBe(TWO_MIB);
    expect(requestCount).toBe(0);
  });

  it('still enforces the envelope shape gate after the stdin refactor', async () => {
    let requestCount = 0;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200);
      response.end('{}');
    });
    installStdin(JSON.stringify({ hook_event_name: 'SessionEnd', cwd: '/p' }));
    vi.stubEnv(
      'SENPI_HOOK_FORWARD_URL',
      `http://127.0.0.1:${serverPort(server)}/senpi-hooks`
    );

    await runSenpiForwarder();

    expect(requestCount).toBe(0);
  });
});

function validEnvelope(): string {
  return JSON.stringify({ event: 'Stop', cwd: '/project' });
}

function envelopeOfBytes(byteLength: number): string {
  const prefix = '{"event":"Stop","cwd":"/project","pad":"';
  const suffix = '"}';
  const padBytes = byteLength - prefix.length - suffix.length;
  if (padBytes < 0) {
    throw new Error('byteLength is smaller than the envelope wrapper');
  }
  return `${prefix}${'x'.repeat(padBytes)}${suffix}`;
}

function spyFetch(): typeof fetch {
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 200 }));
  return spy;
}

function fetchCalls(spy: typeof fetch): readonly (readonly unknown[])[] {
  if (!('mock' in spy)) return [];
  const mock = spy.mock;
  if (typeof mock !== 'object' || mock === null || !('calls' in mock)) {
    return [];
  }
  const calls = mock.calls;
  if (!Array.isArray(calls)) return [];
  return calls.filter((entry): entry is unknown[] => Array.isArray(entry));
}

function fetchUrl(call: readonly unknown[] | undefined): string | undefined {
  const input = call?.[0];
  return typeof input === 'string' ? input : undefined;
}

function fetchInit(
  call: readonly unknown[] | undefined
): Record<string, unknown> {
  const init = call?.[1];
  if (typeof init !== 'object' || init === null || Array.isArray(init)) {
    return {};
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(init)) {
    record[key] = value;
  }
  return record;
}

function installStdin(text: string): void {
  installStdinChunks([Buffer.from(text, 'utf8')]);
}

function installStdinChunks(chunks: readonly Buffer[]): void {
  const stdin: AsyncIterable<Buffer> = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: true,
    value: stdin,
  });
}

function restoreStdin(): void {
  if (originalStdinDescriptor !== undefined) {
    Object.defineProperty(process, 'stdin', originalStdinDescriptor);
    return;
  }
  Reflect.deleteProperty(process, 'stdin');
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

function serverPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an IP server address');
  }
  return address.port;
}
