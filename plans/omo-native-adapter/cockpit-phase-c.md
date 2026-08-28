# Cockpit Phase C - OmO native observe adapter (execution brief)

Status: SPEC · 2026-08-22 · Companion to [planning-brief.md](planning-brief.md)
Audience: implementers in `libar-cockpit` (not this repo)
Scope of this file: cross-repo execution brief only. No cockpit code lands here.

This brief is the mirror plan for the Grok observe slice already shipped in
cockpit under `src/main/services/grok/*` and
`src/main/services/daemon/daemonComposition/grokSessionProcessing.ts`. Phase C
adds a parallel attach-only adapter for OmO native sessions (engine: senpi,
store: `~/.omo/agent`), consuming
`@libar-dev/agent-harness-kit/senpi` and
`@libar-dev/agent-harness-kit/senpi/processing` from the `senpi-adapter`
branch of this kit.

---

## Harness id decision

**Shared schema harness id: `omo`.**

Locked by product owner in `planning-brief.md`:

| Layer | Identifier | Notes |
|---|---|---|
| Product name | OmO native | UI copy, docs, owner language |
| Kit module / package subpaths | `senpi`, `/senpi`, `/senpi/processing` | Engine-accurate; never renamed in the kit |
| Cockpit service directory | `src/main/services/omo/` | Product-facing layer uses `omo`, not `senpi` |
| `SessionHarness` enum value | `'omo'` | Add next to `'claude' \| 'grok'` |
| Canonical session id | `omo:<native-uuid>` | Via `toCanonicalSessionId('omo', nativeId)` |
| Marker subdirectory | `<markersRoot>/omo` | Parallel to `<markersRoot>/grok` |

Do not mix `omo` and `senpi` inside one layer. Kit APIs keep the `Senpi*` /
`senpi` prefix. Cockpit files, harness tags, canonical ids, and markers use
`omo`.

Required schema edits in cockpit (not optional):

- `src/shared/schemas/daemon.ts`: extend
  `SessionHarness = z.enum(['claude', 'grok', 'omo'])`
- `toCanonicalSessionId`: add `case 'omo': return \`omo:${nativeId}\``
- Every `switch (session.harness)` exhaustiveness site gains an `'omo'` arm
  (spawn and drive keep rejecting non-claude, same as grok)

---

## Prerequisite (blocking)

**Cockpit ADR equivalent of ADR 0003 must land before any Phase C wiring.**

Reference shape: `libar-cockpit/docs/decisions/0003-grok-observe-adapter.md`.

The new ADR (suggested path
`libar-cockpit/docs/decisions/000N-omo-observe-adapter.md`) must lock at
minimum:

1. OmO native joins Cockpit as **observe-only external sessions**.
2. Claude remains the only drive plane (spawn, PTY, Commit, managed permission
   prompts).
3. Kit surface consumed is attach-only
   (`/senpi` + `/senpi/processing`). No engine spawn, no RPC, no resume.
4. Identity: `harness: 'omo'`, canonical ids `omo:<native-id>`.
5. Block mapping is lossy onto existing `TranscriptBlock` (no lossless senpi
   union in the renderer).
6. Out of scope for this ADR: OmO spawn/PTY, managed hooks trust write, Stop
   gate forwarding, shared kit `SessionBlock` unification, Kimi.

Implementation PRs in cockpit must cite the accepted ADR. Wiring without it
is out of process.

---

## Merge gate

Owner decision, recorded in `.omo/plans/omo-native-adapter.md` commit
strategy and in `planning-brief.md` Phase C:

> The harness-kit PR on branch `senpi-adapter` must **not** merge until
> Cockpit Phase C is implemented and tested end-to-end in the cockpit repo
> against this branch.

Acceptance for the gate (cockpit side):

1. Pin cockpit's `@libar-dev/agent-harness-kit` dependency at a commit on
   `senpi-adapter` that exports `/senpi` and `/senpi/processing`.
2. Real-daemon E2E (mirror of `tests/main/daemon/grok-e2e-observe.spec.ts`)
   covers discover, open, live catch-up, search, tag, and reset/rematerialize
   against a fixture under a temp agent home shaped like `~/.omo/agent`.
3. Session-end path proves `watchSenpiSession` `quiescent` marks the session
   non-live / ended without any `SessionEnd` hook.
4. Ledger rows added under a new "OmO observe slice" section in
   `docs/feature-reality-ledger.md`; `docs/hooks-contract.md` documents the
   `/senpi` + `/senpi/processing` dynamic imports.

Harness-kit merge is blocked on that evidence, not on this brief alone.

---

## Dynamic ESM import strategy

Cockpit main is CJS. The kit is ESM-only (`"type": "module"`, no `require`
condition). Same permanent seam as Claude `/processing` and Grok
`/grok/processing` (see `docs/hooks-contract.md`).

| Subpath | Load site | Named exports cockpit consumes |
|---|---|---|
| `@libar-dev/agent-harness-kit/senpi` | `omoRuntime.ts` (home resolution only, if not covered by listing options) | `resolveSenpiAgentHome`, `AGENT_DIR_ENV_NAMES` |
| `@libar-dev/agent-harness-kit/senpi/processing` | `omoProcessing.ts` default loader; also direct dynamic import in `omoDiscovery.ts` / `omoRuntime.ts` where Grok does the same for list/encode | `listSenpiSessions`, `listAllSenpiSessions`, `findSenpiSessionDirs`, `getSenpiSessionsRoot`, `encodeSenpiCwdDirname`, `tailSenpiSession`, `watchSenpiSession`, `commitSenpiSessionCheckpoint`, `foldSenpiBlockChanges`, `reduceSenpiProjection` |

Rules:

- **No static `import` from either subpath** in main-process production code
  unless cockpit later chooses a bundler path that makes static ESM safe.
  Default: `await import('...')` only.
- Centralize the processing load behind `loadOmoProcessing()` (mirror of
  `loadGrokProcessing`) with `setOmoProcessingLoaderForTests` for unit tests.
- Surface load failures as `OmoIngestError` code `adapter-load-failed`.
- Do not add a static dependency edge in TypeScript `import type` from value
  space that forces resolution at load time; `import type` of kit types is
  fine and erases at emit.
- Pin stays a git commit SHA in cockpit `package.json`, same pattern as today.

Update `libar-cockpit/docs/hooks-contract.md` when wiring lands: add a
"/senpi and /senpi/processing (contracted)" table next to the Grok table.

---

## Session-end detection (no SessionEnd)

Senpi's supported hook events are exactly seven:
`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`,
`PreCompact`, `PostCompact`, `Stop`. There is **no `SessionEnd`**.

Claude path today ends sessions via `SessionEnd` in
`sessionLifecycle/hookIngress.ts`. That path does not exist for OmO.

**Primary end signal: `watchSenpiSession` quiescence.**

| Signal | Source | Cockpit action |
|---|---|---|
| `watchSenpiSession` yields `{ type: 'quiescent' }` | kit `/senpi/processing`, default `quiescenceMs = 30000` | Mark observed session `status: 'ended'`, stop or back off the observer, emit list invalidation |
| Discovery `isLive` | `nowMs - mtimeMs < COCKPIT_LIVE_WINDOW_MS` on the session `.jsonl` | Catalog liveness only; does not replace the end signal |
| `Stop` hook (optional later) | observe-only forwarder, if registered in Phase D | Weak activity signal only; must not drive gate/block in Phase C |

Implementation notes for cockpit:

1. Live catch-up can keep the existing poll observer pattern in
   `sessionLifecycle/observation.ts` (stat the single `.jsonl` path; senpi is
   one file, so the Claude `stat(session.jsonlPath)` arm works once
   `harness === 'omo'` is not forced through `statGrokSessionSources`).
2. Session-end must additionally run (or subscribe to) `watchSenpiSession` and
   treat one `quiescent` yield as end. Do not invent a fake `SessionEnd`
   envelope.
3. Default window: kit `quiescenceMs` 30000. Tune only with fixture evidence;
   inject `clock` in tests (no real sleeps).
4. Missing file: watch retains the checkpoint and does not reset until a
   replacement is observed. Cockpit must not clear SQLite history on transient
   ENOENT during that window.
5. Features that currently key off Claude `SessionEnd` (status flip, list
   event reason strings) degrade to the quiescent path for `harness === 'omo'`.
   They must not break.

---

## Lossy block map: `SenpiSessionBlock` → `TranscriptBlock` / `DaemonSessionSummary`

### A. `SenpiSessionInfo` → `DaemonSessionSummary`

Source: kit `listSenpiSessions` / `listAllSenpiSessions` → `ValidSenpiSession.info`.

| `DaemonSessionSummary` field | Source | Notes |
|---|---|---|
| `projectCwd` | discovery call arg | Header cwd already verified by kit listing |
| `sessionId` | `toCanonicalSessionId('omo', info.id)` | `omo:<uuid>` |
| `jsonlPath` | `info.path` | Absolute path of the session `.jsonl` file (not a directory) |
| `startedAt` | `info.created.toISOString()` | Header timestamp |
| `mtimeMs` | `info.modified.getTime()` | File mtime from listing |
| `isLive` | `nowMs - mtimeMs < COCKPIT_LIVE_WINDOW_MS` | Same window constant as Grok/Claude |
| `firstUserText` | `info.firstMessage` | Kit already extracts first user text |
| `spawnedBy` | `'external'` | Always; OmO is never cockpit-spawned in Phase C |
| `controllerStatus` | `null` | No PTY |
| `harness` | `'omo'` | |
| `title` | `info.name ?? null` | Latest `session_info` entry display name |

**Fields dropped from `SenpiSessionInfo` (not on `DaemonSessionSummary`):**

- `cwd` (redundant after project filter; do not surface as a summary column)
- `messageCount`
- `parentSessionPath` (fork lineage; optional later as system/info on open, not catalog)

Invalid listings (`kind: 'invalid'`) are logged and skipped, same as Grok
invalid sessions.

### B. `SenpiSessionBlock` → `TranscriptBlock`

Source blocks come from kit `tailSenpiSession` changes, optionally folded via
`foldSenpiBlockChanges` on rematerialize. Normalize in `omoNormalize.ts`.
Canonical block ids: prefix with `omo:` when absent (mirror
`toCanonicalBlockId` in `grokNormalize.ts`).

| Senpi input | Transcript output | Mapping rule |
|---|---|---|
| `message` + role `user` + content `text` | `user_text` | `content = text.text` |
| `message` + role `user` + content `image` | `image` | `data`, `mediaType` from `mimeType` when it matches the allowed enum; else `system/info` fallback |
| `message` + role `assistant` + content `text` | `assistant_text` | `content = text.text` |
| `message` + role `assistant` + content `thinking` | `thinking` | `content = thinking.thinking` |
| `message` + role `assistant` + content `toolCall` | `tool_use` | `toolUseId = toolCall.id`, `toolName = toolCall.name`, `input = toolCall.arguments`, `summary = toolCall.name` |
| `message` + role `toolResult` | `tool_result` | `toolUseId =` from message (via content/role fields retained on the block through reduction; use `entryId` only as id seed, not as tool id). Prefer reading tool linkage from the native message before reduction if the block alone is insufficient; Phase C normalize may need the folded message role fields already on `SenpiMessageBlock` (`isError`) plus text join of content. `toolName` when known. `structuredResult` left unset unless a single structured payload is cheap to attach. |
| `message` + role `bashExecution` | `system` / `kind: 'info'` | Title `omo.bashExecution`; body = bounded JSON of command/output/exit |
| `message` + role `branchSummary` | `system` / `kind: 'info'` | Title `omo.branchSummary` |
| `message` + role `compactionSummary` | `system` / `kind: 'info'` | Title `omo.compactionSummary` |
| `message` + role `custom` | `system` / `kind: 'info'` | Title `omo.custom.<customType\|unknown>`; high-volume extension traffic (`senpi.todo-state`, `omo-senpi:wake`, …) stays inspectable, never dropped silently |
| `metadata` (any `entryType`) | `system` / `kind: 'info'` | Title `omo.meta.<entryType>`; body = bounded JSON of `payload` (+ `customType` when set) |
| `SenpiBlockChange` type `delete` | `SessionMutation` type `delete` | `blockId = toCanonicalBlockId(id)` |
| Tail diagnostics (if any) | `system` / `kind: 'info'` | Collapse per kind, same throttle pattern as Grok diagnostics |

**Fields always dropped on the way into `TranscriptBlock` (lossy by design):**

From `SenpiSessionBlockBase`:

- `parentId`
- `origin` (`entry` \| `retained_tail`)
- `branch` (`active` \| `off_branch` \| `summarized`)
- `entryType` (except as the system/info title suffix for metadata)
- `entryId` (except as the native id seed before `omo:` prefixing)
- `entryTimestamp` when `messageTimestamp` is used (pick message time; fall back to entry time; never keep both)
- `usage` (`SenpiUsage` input/output/cache/cost)
- `customType` as a first-class Transcript field (survives only inside system/info title or body)
- `isError` on non-`tool_result` mappings (assistant errors become system/info or a flag only on tool_result)

From content payloads:

- `thinking.startedAt`, `thinking.endedAt`
- Assistant wire fields not on the block surface after reduction: `api`,
  `provider`, `model`, `stopReason`, `errorMessage` (unless folded into a
  system/info companion for the error case)
- `toolResult.details`, `toolResult.usage`
- `bashExecution.command`, `exitCode`, `cancelled`, `truncated`,
  `fullOutputPath`, `excludeFromContext` as typed fields (only inside
  bounded JSON body)
- `custom.display`, `custom.details`
- `branchSummary.fromId`, `compactionSummary.tokensBefore` as typed fields
- Off-path projection records not reduced into active blocks (kit leaves
  those on `SenpiProjectionResult.offPath`; cockpit Phase C does not render
  them unless a later decision says otherwise)

Bounds: reuse Grok's `SYSTEM_INFO_MAX_CHARS = 2048` for system/info bodies.
Collapse repeated diagnostic/customType keys the way
`collapseDiagnostics` does for Grok.

No shared kit `SessionBlock`. No attempt to round-trip OmO blocks through the
Claude JSONL normalizer.

---

## File-by-file mapping

Paths on the left are current cockpit files. Paths on the right are the
cockpit files to **create** (new `omo/` tree) or **modify** (shared wiring).
Kit symbols are the harness-kit exports each file should call.

### New service tree (mirror of `src/main/services/grok/`)

| Cockpit Grok file | Cockpit OmO file to create | What changes |
|---|---|---|
| `src/main/services/grok/grokDiscovery.ts` | `src/main/services/omo/omoDiscovery.ts` | `discoverOmoSessions({ projectCwd, options })` dynamically imports `listSenpiSessions` from `/senpi/processing`, passes `agentHome` from `resolveOmoHome`, maps valid `SenpiSessionInfo` → `DaemonSessionSummary` with `harness: 'omo'`, logs+skips invalid rows |
| `src/main/services/grok/grokIngest.ts` | `src/main/services/omo/omoIngest.ts` | `ingestOmoSession` / `previewOmoSessionHistory` call `tailSenpiSession` + optional `foldSenpiBlockChanges`, normalize via `omoNormalize`, persist through existing `sessionMutationStream` helpers, commit via `commitSenpiSessionCheckpoint`; `jsonlPath` is the `.jsonl` file path |
| `src/main/services/grok/grokIngestError.ts` | `src/main/services/omo/omoIngestError.ts` | Same code union (`adapter-load-failed`, `source-read-failed`, `persistence-failed`, `checkpoint-commit-failed`) under `OmoIngestError` / `asOmoIngestError` |
| `src/main/services/grok/grokIngestSerializer.ts` | `src/main/services/omo/omoIngestSerializer.ts` | Per-canonical-session serial queue + reentrancy guard; copy structure, rename types only (`createOmoIngestSerializer`) |
| `src/main/services/grok/grokNormalize.ts` | `src/main/services/omo/omoNormalize.ts` | Implement the lossy map in section "Lossy block map"; input types from `/senpi/processing` (`SenpiBlockChange`, `SenpiSessionBlock`, tail diagnostics if exposed) |
| `src/main/services/grok/grokProcessing.ts` | `src/main/services/omo/omoProcessing.ts` | `loadOmoProcessing()` → `import('@libar-dev/agent-harness-kit/senpi/processing')`; test loader override; wrap failures as `adapter-load-failed` |
| `src/main/services/grok/grokRuntime.ts` | `src/main/services/omo/omoRuntime.ts` | `getOmoSessionMarkersDir` → `join(getSessionMarkersDir(options), 'omo')`; `resolveOmoHome` prefers kit `resolveSenpiAgentHome({ env, homeDir })` (honors `OMO_CODING_AGENT_DIR` / `SENPI_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR`) rather than inventing a parallel home algorithm; `resolveOmoSessionScopes` uses `getSenpiSessionsRoot` + `encodeSenpiCwdDirname` and returns `{ projectCwd, sessionsRoot }` for catalog watch |
| `src/main/services/grok/grokSessionFs.ts` | `src/main/services/omo/omoSessionFs.ts` | `isOmoSessionFile(path)` (`.jsonl` file whose first parseable header is senpi session v3, or cheaper: file under agent sessions root with `.jsonl` suffix + readable header); `statOmoSessionSource(path)` returns `{ mtimeMs, size }` for the single file (no `events.jsonl`) |

### New daemon composition processor

| Cockpit Grok file | Cockpit OmO file to create | What changes |
|---|---|---|
| `src/main/services/daemon/daemonComposition/grokSessionProcessing.ts` | `src/main/services/daemon/daemonComposition/omoSessionProcessing.ts` | `createOmoSessionProcessor`: `loadHistory` / `reindexSession` call `previewOmoSessionHistory` / `ingestOmoSession` through `OmoIngestSerializer`; persist `harness: 'omo'` on `upsertSession` |

### Shared wiring to modify (not silent drops)

These are not under `services/grok/` but already branch on Grok and must grow
an OmO arm. Listed so the completeness pass cannot miss them.

| Cockpit file | Change |
|---|---|
| `src/shared/schemas/daemon.ts` | `SessionHarness` + `toCanonicalSessionId` for `'omo'` |
| `src/main/services/daemon/daemonComposition/contracts.ts` | Hold `omoIngestSerializer` next to `grokIngestSerializer` |
| `src/main/services/daemon/daemonComposition/createComposition.ts` | Construct `createOmoIngestSerializer`, wire `discoverOmoSessions` + `resolveOmoSessionScopes` into search + catalog watcher deps |
| `src/main/services/daemon/daemonComposition/createDaemon.ts` | `createOmoSessionProcessor` and pass into history/reindex |
| `src/main/services/daemon/daemonComposition/sessionHistory.ts` | Route `harness === 'omo'` or `isOmoSessionFile(jsonlPath)` to `omoSessionProcessor` |
| `src/main/services/daemon/daemonComposition/projectReindex.ts` | `case 'omo':` → `omoSessionProcessor.reindexSession` |
| `src/main/services/daemon/sessionLifecycle/contracts.ts` | Optional `omoIngestSerializer` dep |
| `src/main/services/daemon/sessionLifecycle/ingest.ts` | `catchUpOmoSession` via `ingestOmoSession` when `harness === 'omo'` |
| `src/main/services/daemon/sessionLifecycle/observation.ts` | Stat path: single-file stat for `omo` (not grok multi-file); session-end via `watchSenpiSession` quiescent (see above) |
| `src/main/services/daemon/sessionLifecycle/observationErrors.ts` | Treat `OmoIngestError` like `GrokIngestError` for recoverable retry |
| `src/main/services/daemon/sessionLifecycle/spawnControl.ts` | `case 'omo':` reject with `unsupported-harness` (mirror grok) |
| `src/main/services/daemon/sessionLifecycle/authorization.ts` | Non-claude drive rejection already covers omo once the enum widens; confirm exhaustiveness |
| `src/main/services/daemon/sessionCatalogWatcher/contracts.ts` | `resolveOmoSessionScopes` / `discoverOmoSessions` optional deps |
| `src/main/services/daemon/sessionCatalogWatcher/scopeInitializer.ts` | Register omo sessionsRoot scopes next to grok |
| `src/main/services/daemon/searchService/contracts.ts` | `discoverOmoSessions` optional dep; include omo summaries in discovery context |
| `src/main/services/daemon/searchService/discovery.ts` | Merge omo summaries into discovered set |
| `src/main/services/daemon/searchService/sessionCatalog.ts` | Catalog lookup includes omo summaries (same merge pattern as grok) |
| `docs/hooks-contract.md` | Document `/senpi` + `/senpi/processing` dynamic import seam |
| `docs/feature-reality-ledger.md` | New OmO observe slice rows after E2E |
| `docs/decisions/000N-omo-observe-adapter.md` | Prerequisite ADR (see above) |

### Tests to add in cockpit (guidance, not exhaustive)

| Grok test fixture | OmO counterpart |
|---|---|
| `tests/main/daemon/grok-discovery.spec.ts` | `omo-discovery.spec.ts` |
| `tests/main/daemon/grok-ingest.spec.ts` | `omo-ingest.spec.ts` |
| `tests/main/daemon/grok-e2e-observe.spec.ts` | `omo-e2e-observe.spec.ts` (merge-gate evidence) |
| `tests/main/daemon/grok-reset-checkpoint.spec.ts` | `omo-reset-checkpoint.spec.ts` (suffix-splice rematerialize) |
| `docs/qa/grok-observe-qa.md` | `docs/qa/omo-observe-qa.md` |

Use kit fixtures under harness-kit `tests/fixtures/senpi/` (sanitized) or a
cockpit-local copy; never commit unredacted `~/.omo/agent` transcripts.

---

## Kit export surface this brief assumes

Landed (or landing on `senpi-adapter`) public names cockpit may call:

**`@libar-dev/agent-harness-kit/senpi`** (from `src/senpi/index.ts`):
`resolveSenpiAgentHome`, `AGENT_DIR_ENV_NAMES`, `AGENT_HOME_SENTINEL`,
hooks-config validators, session entry types. Phase C observe needs home
resolution primarily; hooks registration is Phase D.

**`@libar-dev/agent-harness-kit/senpi/processing`** (from
`src/senpi/processing/index.ts`):
`parseSenpiEntry`, `findSenpiSessionDirs`, `getSenpiSessionsRoot`,
`listSenpiSessions`, `listAllSenpiSessions`, `projectSenpiBranch`,
`resolveSenpiLeaf`, `tailSenpiSession`, `watchSenpiSession`,
`commitSenpiSessionCheckpoint`, `foldSenpiBlockChanges`,
`reduceSenpiProjection`, plus block/listing types
(`SenpiSessionBlock`, `SenpiBlockChange`, `SenpiSessionInfo`, …).

Cursor and checkpoint marker internals stay unexported. Cockpit must not
reach into kit private paths.

`encodeSenpiCwdDirname` is exported from the processing module source
(`discovery.ts`) and is part of the processing surface cockpit runtime uses
for scope roots (same role as Grok's `encodeGrokCwdDirname`). If the barrel
ever omits it, Phase C unblocks by exporting it from
`src/senpi/processing/index.ts` in the kit before cockpit wiring merges.

---

## Explicit non-goals (Phase C)

- No OmO/senpi spawn, PTY, Commit, or CLI resume from cockpit
- No managed hooks trust write, forwarder install, or Stop-gate block policy
  (Phase D / later cockpit work)
- No translation of senpi hook envelopes into the Claude hook sink
- No reading `auth.json` or `omo-senpi/` telemetry state
- No multi-home auto-merge (second stores only via env / explicit home option)
- No shared `SessionBlock` unification across claude/grok/omo in the kit
- No code changes in harness-kit for Phase C beyond what Phases A/B/D already
  plan; this brief is cockpit work specified from the kit repo

---

## Implementation order (cockpit)

1. Land prerequisite ADR (`000N-omo-observe-adapter`).
2. Schema: `SessionHarness` + `toCanonicalSessionId`.
3. Create `src/main/services/omo/*` tree (processing load → runtime → fs →
   normalize → ingest → discovery → serializer → errors).
4. Create `omoSessionProcessing.ts`; wire composition, history, reindex,
   search, catalog, lifecycle ingest/observe/errors/spawn reject.
5. Session-end: `watchSenpiSession` quiescent path.
6. Unit tests, then real-daemon E2E, then QA doc + ledger + hooks-contract
   update.
7. Point cockpit pin at the `senpi-adapter` commit under test; only then is
   the harness-kit merge gate eligible to open.

---

## GAPS

Items intentionally not given a 1:1 new file, with reason. Nothing under
`services/grok/` is omitted from the mapping table above.

| Item | Reason |
|---|---|
| Grok two-file layout (`updates.jsonl` + `events.jsonl`) helpers inside `grokSessionFs` / ingest `eventsMissing` | Senpi is a single `.jsonl`; no events file. `eventsMissing` has no OmO analogue (always false / omit field). |
| Grok `includeActivities: true` tail option | Senpi tail options differ (`SenpiSessionTailOptions`); no activities stream. Map only real senpi options (`markerDir`, `allowedMarkerRoots`, `fromStart`, checkpoint mode). |
| Claude `SessionEnd` hook ingress | No senpi SessionEnd. Covered by quiescence section, not a new hook handler. |
| Grok `/grok` hooks subpath (`executeGrokHook`, …) | Phase C is observe-only. Senpi hooks library is Phase B/D in the kit; cockpit managed registration is out of Phase C scope. |
| Direct reuse of `GrokIngestSerializer` without rename | Forbidden. Separate serializer instance avoids cross-harness queue coupling and keeps stop/shutdown independent. |
| Renderer/UI chrome beyond existing external-session views | Out of scope for this brief; existing external session UI should accept `harness: 'omo'` once summaries flow. Any dedicated badge copy is a separate cockpit UI task. |

---

## Completeness checklist

Every file currently under
`libar-cockpit/src/main/services/grok/` plus
`daemonComposition/grokSessionProcessing.ts` must appear in the mapping
table. Run at brief-authoring time:

```bash
# From harness-kit repo, against a local cockpit checkout.
GROK_DIR=/Users/darkomijic/dev-libar/libar-cockpit/src/main/services/grok
BRIEF=plans/omo-native-adapter/cockpit-phase-c.md

echo "== grok service files =="
for f in "$GROK_DIR"/*.ts; do
  base=$(basename "$f")
  if rg -q "$base" "$BRIEF"; then
    echo "MATCH  $base"
  else
    echo "MISS   $base"
  fi
done

echo "== grokSessionProcessing =="
base=grokSessionProcessing.ts
if rg -q "$base" "$BRIEF"; then echo "MATCH  $base"; else echo "MISS   $base"; fi
```

Expected: every line `MATCH`. Any `MISS` must move into GAPS with a written
reason before this brief is accepted.

Authoring-time audit output is recorded in
`.omo/evidence/task-23-phase-c-brief.log`.
