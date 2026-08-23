#!/usr/bin/env -S pnpm exec tsx
/**
 * Live smoke probe for the senpi adapter against a real OmO agent store.
 *
 * Read-only by contract: resolves the agent home, lists sessions, tails one
 * session file in manual checkpoint mode, and folds its block change stream.
 * Never writes tail markers, trust, hooks, or config. Use it to answer "does
 * the adapter see what the running harness sees?" without touching the store.
 *
 * Usage:
 *   pnpm senpi:smoke                          # probe $PI_SESSION_FILE (the live session)
 *   pnpm senpi:smoke <session.jsonl path>     # probe an explicit session file
 *   pnpm senpi:smoke --project <cwd>          # scope listing to one project cwd
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveSenpiAgentHome } from '../src/senpi/home.js';
import { getSenpiSessionsRoot } from '../src/senpi/processing/discovery.js';
import {
  listAllSenpiSessions,
  listSenpiSessions,
} from '../src/senpi/processing/listing.js';
import { getSenpiSessionMarkerPath } from '../src/senpi/processing/checkpoint.js';
import { tailSenpiSession } from '../src/senpi/processing/tail.js';
import { foldSenpiBlockChanges } from '../src/senpi/processing/blocks.js';
import {
  assertSenpiSmokeProbeInputsUnchanged,
  hashSenpiSmokeProbeInputs,
} from './senpi-smoke-safety.js';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
  },
  allowPositionals: true,
});

const [sessionArg] = values.project === undefined ? process.argv.slice(2) : [];
const sessionFile = sessionArg ?? process.env.PI_SESSION_FILE;
if (sessionFile === undefined || sessionFile === '') {
  console.error(
    'No session file: pass a path or run inside OmO with PI_SESSION_FILE set.'
  );
  process.exit(1);
}

const home = resolveSenpiAgentHome();
console.log('agentHome:', home);
console.log('sessionsRoot:', getSenpiSessionsRoot(home));

const all = await listAllSenpiSessions({ agentHome: home });
const valid = all.filter(entry => entry.kind === 'valid');
const invalid = all.filter(entry => entry.kind !== 'valid');
console.log(
  `listAllSenpiSessions: ${valid.length} valid, ${invalid.length} invalid`
);
for (const bad of invalid.slice(0, 5)) {
  console.log(
    '  invalid:',
    bad.path.split('/').pop(),
    String(bad.error).slice(0, 80)
  );
}

if (values.project !== undefined) {
  const scoped = await listSenpiSessions(values.project, { agentHome: home });
  for (const entry of scoped) {
    if (entry.kind === 'valid') {
      console.log(
        `  ${entry.info.id.slice(0, 8)} msgs=${entry.info.messageCount} first=${JSON.stringify(entry.info.firstMessage?.slice(0, 60))}`
      );
    }
  }
}

const probePaths = [
  getSenpiSessionMarkerPath(sessionFile),
  join(home, 'settings.json'),
  sessionFile,
] as const;
const probeBefore = await hashSenpiSmokeProbeInputs(probePaths);

const tail = await tailSenpiSession(sessionFile, { checkpointMode: 'manual' });
console.log(
  `tail: records=${tail.records.length} leafKind=${tail.leaf.kind} bytes=${tail.nextByteOffset}/${tail.fileSize} gen=${tail.generation} rev=${tail.revision} reset=${String(tail.reset)} diagnostics=${tail.diagnostics.length}`
);
for (const diagnostic of tail.diagnostics.slice(0, 5)) {
  console.log('  diagnostic:', JSON.stringify(diagnostic).slice(0, 120));
}

const blocks = foldSenpiBlockChanges(tail.changes);
const byRole = new Map<string, number>();
let customTyped = 0;
for (const block of blocks) {
  byRole.set(block.role, (byRole.get(block.role) ?? 0) + 1);
  if (block.customType !== undefined) customTyped += 1;
}
console.log(
  `blocks: ${blocks.length} roles=${JSON.stringify(Object.fromEntries(byRole))} customTyped=${customTyped}`
);

const second = await tailSenpiSession(sessionFile, {
  checkpointMode: 'manual',
});
console.log(
  `re-tail stable: ${second.revision === tail.revision && second.mutations.length === 0 ? 'yes' : 'NO'} (rev=${second.revision}, mutations=${second.mutations.length})`
);

const probeAfter = await hashSenpiSmokeProbeInputs(probePaths);
assertSenpiSmokeProbeInputsUnchanged(probeBefore, probeAfter);
