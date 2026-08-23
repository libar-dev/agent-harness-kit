import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const documentedConcreteSubpaths = [
  '.',
  './processing',
  './grok',
  './grok/processing',
  './senpi',
  './senpi/processing',
  './validation',
  './types',
  './utils',
  './pre-tool-use',
  './post-tool-use',
  './lifecycle',
  './endpoint-discovery',
  './forwarder',
];

const documentedWildcardExamples = [
  './pre-tool-use/bash-validator',
  './post-tool-use/format-code',
  './lifecycle/setup',
];

const undocumentedInternalSubpaths = [
  './processing/internal',
  './processing/tail',
  './senpi/trust',
  './senpi/processing/jsonl-cursor',
  './grok/processing/jsonl-cursor',
];

const grokUpdates = `${JSON.stringify({
  timestamp: 1786591371,
  method: 'session/update',
  params: {
    sessionId: 'session-clean-consumer',
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'clean consumer grok turn' },
      _meta: { modelId: 'model-redacted', promptIndex: 0 },
    },
    _meta: { eventId: 'event-clean-1' },
  },
})}\n`;

const grokEvents = `${JSON.stringify({
  ts: '2026-08-13T03:22:48.889Z',
  type: 'turn_started',
  session_id: 'session-clean-consumer',
  turn_number: 0,
})}\n`;

const senpiSession = `${JSON.stringify({
  type: 'session',
  version: 3,
  id: 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeee0008',
  timestamp: '2026-01-08T00:00:00.000Z',
  cwd: '/tmp/clean-consumer',
})}
${JSON.stringify({
  type: 'message',
  id: 'h1000001',
  parentId: null,
  timestamp: '2026-01-08T00:00:01.000Z',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'clean consumer senpi turn' }],
    timestamp: 1704672001000,
  },
})}
`;

function specifierForSubpath(subpath) {
  return subpath === '.'
    ? '@libar-dev/agent-harness-kit'
    : `@libar-dev/agent-harness-kit/${subpath.slice(2)}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function importSubpath(subpath) {
  const specifier = specifierForSubpath(subpath);
  try {
    const mod = await import(specifier);
    return { ok: true, keys: Object.keys(mod).sort() };
  } catch (error) {
    const code =
      isRecord(error) && typeof error.code === 'string' ? error.code : 'UNKNOWN';
    return { ok: false, code };
  }
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(options.stdin ?? '');
  });
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a TCP address'));
        return;
      }
      resolve({ server, port: address.port });
    });
    server.once('error', reject);
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}

async function resolveKitRoot() {
  const indexPath = fileURLToPath(
    import.meta.resolve('@libar-dev/agent-harness-kit')
  );
  return join(dirname(indexPath), '..');
}

async function exerciseGrok(tailGrokSession, workspace) {
  const sessionDir = join(workspace, 'grok-session');
  const markerDir = join(workspace, 'grok-markers');
  await mkdir(sessionDir, { recursive: true });
  await mkdir(markerDir, { recursive: true });
  await writeFile(join(sessionDir, 'updates.jsonl'), grokUpdates);
  await writeFile(join(sessionDir, 'events.jsonl'), grokEvents);
  const result = await tailGrokSession(sessionDir, {
    checkpointMode: 'manual',
    markerDir,
    allowedMarkerRoots: [workspace],
  });
  if (!isRecord(result) || !Array.isArray(result.records)) {
    throw new Error('tailGrokSession did not return records');
  }
  if (result.records.length === 0) {
    throw new Error('tailGrokSession returned no records');
  }
  return {
    ok: true,
    recordCount: result.records.length,
    changeCount: Array.isArray(result.changes) ? result.changes.length : 0,
  };
}

async function exerciseSenpi(tailSenpiSession, workspace) {
  const sessionPath = join(workspace, 'senpi-session.jsonl');
  const markerDir = join(workspace, 'senpi-markers');
  await mkdir(markerDir, { recursive: true });
  await writeFile(sessionPath, senpiSession);
  const result = await tailSenpiSession(sessionPath, {
    checkpointMode: 'manual',
    markerDir,
    allowedMarkerRoots: [workspace],
  });
  if (!isRecord(result) || !Array.isArray(result.records)) {
    throw new Error('tailSenpiSession did not return records');
  }
  if (result.records.length === 0) {
    throw new Error('tailSenpiSession returned no records');
  }
  return {
    ok: true,
    recordCount: result.records.length,
    mutationCount: Array.isArray(result.mutations) ? result.mutations.length : 0,
    nextByteOffset:
      typeof result.nextByteOffset === 'number' ? result.nextByteOffset : null,
  };
}

async function exerciseClaudeForwarder(forwarderPath, workspace) {
  const projectRoot = await realpath(workspace);
  const decision = '{"decision":"allow"}';
  const { server, port } = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(decision);
  });
  const endpointPath = join(workspace, 'claude-endpoint.json');
  await writeFile(
    endpointPath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port,
      token: '0123456789abcdef0123456789abcdef',
      startedAt: new Date().toISOString(),
      projectRoots: [projectRoot],
    })
  );
  try {
    const result = await runProcess(process.execPath, [forwarderPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AGENT_HOOK_ENDPOINT_FILE: endpointPath,
      },
      stdin: JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: projectRoot,
      }),
    });
    if (result.code !== 0 || result.stdout !== decision) {
      throw new Error(
        `claude forwarder failed: code=${String(result.code)} stdout=${result.stdout} stderr=${result.stderr}`
      );
    }
    return { ok: true, stdout: result.stdout, code: result.code };
  } finally {
    await closeServer(server);
  }
}

async function exerciseSenpiForwarder(forwarderPath, workspace) {
  const envelope = JSON.stringify({
    event: 'PreToolUse',
    cwd: workspace,
  });
  /** @type {{ body: string } | null} */
  let received = null;
  const { server, port } = await listen((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received = { body: Buffer.concat(chunks).toString('utf8') };
      response.writeHead(204);
      response.end();
    });
  });
  try {
    const result = await runProcess(process.execPath, [forwarderPath], {
      cwd: workspace,
      env: {
        ...process.env,
        SENPI_HOOK_FORWARD_URL: `http://127.0.0.1:${String(port)}/observe`,
      },
      stdin: envelope,
    });
    if (result.code !== 0 || result.stdout !== '') {
      throw new Error(
        `senpi forwarder failed: code=${String(result.code)} stdout=${result.stdout} stderr=${result.stderr}`
      );
    }
    if (received === null || received.body !== envelope) {
      throw new Error('senpi forwarder did not deliver the envelope');
    }
    return { ok: true, delivered: true, code: result.code };
  } finally {
    await closeServer(server);
  }
}

async function main() {
  const imports = {};
  for (const subpath of [
    ...documentedConcreteSubpaths,
    ...documentedWildcardExamples,
  ]) {
    const result = await importSubpath(subpath);
    imports[subpath] = result;
    if (!result.ok) {
      throw new Error(`documented subpath ${subpath} failed: ${result.code}`);
    }
    if (result.keys.length === 0) {
      throw new Error(`documented subpath ${subpath} exported no keys`);
    }
  }

  const rejected = {};
  for (const subpath of undocumentedInternalSubpaths) {
    const result = await importSubpath(subpath);
    rejected[subpath] = result;
    if (result.ok || result.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw new Error(
        `internal subpath ${subpath} was not rejected with ERR_PACKAGE_PATH_NOT_EXPORTED`
      );
    }
  }

  const grokProcessing = await import(
    '@libar-dev/agent-harness-kit/grok/processing'
  );
  const senpiProcessing = await import(
    '@libar-dev/agent-harness-kit/senpi/processing'
  );
  const forwarder = await import('@libar-dev/agent-harness-kit/forwarder');
  if (typeof grokProcessing.tailGrokSession !== 'function') {
    throw new Error('missing tailGrokSession');
  }
  if (typeof senpiProcessing.tailSenpiSession !== 'function') {
    throw new Error('missing tailSenpiSession');
  }

  const kitRoot = await resolveKitRoot();
  const claudeForwarder = join(kitRoot, forwarder.STANDALONE_HOOK_FORWARDER_ASSET);
  const senpiForwarder = join(
    kitRoot,
    forwarder.STANDALONE_SENPI_HOOK_FORWARDER_ASSET
  );

  const workspace = await mkdtemp(join(tmpdir(), 'kit-clean-consumer-probe-'));
  await writeFile(join(workspace, '.keep'), '');
  try {
    const grok = await exerciseGrok(grokProcessing.tailGrokSession, workspace);
    const senpi = await exerciseSenpi(
      senpiProcessing.tailSenpiSession,
      workspace
    );
    const claudeForward = await exerciseClaudeForwarder(
      claudeForwarder,
      workspace
    );
    const senpiForward = await exerciseSenpiForwarder(senpiForwarder, workspace);
    const report = {
      ok: true,
      node: process.version,
      execPath: process.execPath,
      imported: Object.keys(imports),
      imports,
      rejected,
      grok,
      senpi,
      forwarder: {
        claude: claudeForward,
        senpi: senpiForward,
        assets: {
          claude: forwarder.STANDALONE_HOOK_FORWARDER_ASSET,
          senpi: forwarder.STANDALONE_SENPI_HOOK_FORWARDER_ASSET,
        },
      },
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
