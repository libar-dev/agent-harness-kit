# Senpi Adapter Reference

OmO-native (senpi engine) support in `@libar-dev/agent-harness-kit/senpi` and `@libar-dev/agent-harness-kit/senpi/processing`.

**Sources:** [`src/senpi/`](../../src/senpi/index.ts), [`src/senpi/processing/`](../../src/senpi/processing/index.ts), vendored upstream contract files under [`docs/upstream/senpi/`](../upstream/senpi/NOTICE)

**Scope:** attach-only. The library answers senpi hook calls and reads senpi's on-disk session files. It does not start, spawn, drive, or RPC-control senpi sessions. Observe never drives.

## Events and gate kinds

Senpi configuration accepts exactly 7 events. Config keys and the wire discriminator `event` use canonical PascalCase only. Unlike Grok, there are no snake_case or camelCase event-name aliases on the config side.

| Wire value (`event`) | Gate kind  | stdout honored                                                                                                                     |
| -------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PreToolUse`         | Tool gate  | Yes: `decision` (`allow`/`approve`/`ask`/`deny`), `reason`, `additionalContext`, `updatedInput` (only when allow), `systemMessage` |
| `PostToolUse`        | Block gate | Yes: `decision` (`block` only), `reason`, `additionalContext`, `updatedToolOutput`, `systemMessage`                                |
| `UserPromptSubmit`   | Block gate | Yes: `decision` (`block` only), `reason`, `additionalContext`, `systemMessage`                                                     |
| `SessionStart`       | Observe    | `additionalContext`, `systemMessage` (any `decision` is rejected with a warning)                                                   |
| `PreCompact`         | Observe    | No (gate-out: no decision, context, or `systemMessage`)                                                                            |
| `PostCompact`        | Observe    | No (gate-out: no decision, context, or `systemMessage`)                                                                            |
| `Stop`               | Stop gate  | Yes: `decision` (`block` or `continue`), `reason`, `additionalContext`, `continue`, `stopReason`, `systemMessage`                  |

`PreToolUse` is the only Tool gate. `PostToolUse` and `UserPromptSubmit` honor only `decision: "block"`. `Stop` is the Stop gate (`continue: false` implies `decision: "block"`). `SessionStart`, `PreCompact`, and `PostCompact` are Observe: gate decisions are ignored or unsupported.

The exported `SENPI_HOOK_EVENT_NAMES` array lists the 7 canonical names. `SENPI_UNSUPPORTED_HOOK_EVENT_NAMES` lists upstream event names this kit rejects as `unsupported_event`. `senpiHookInputSchema` validates envelopes for each supported event.

## Envelope contract

Envelopes are JSON objects read from stdin. Primaries are camelCase. Optional snake_case aliases exist on the same object and are normalized once at the wire boundary by `validateSenpiHookInput` / `senpiHookInputSchema` (alias fills a missing primary; an explicit primary always wins).

| Alias (snake_case) | Primary (camelCase) |
| ------------------ | ------------------- |
| `hook_event_name`  | `event`             |
| `session_id`       | `sessionId`         |
| `tool_name`        | `toolName`          |
| `tool_input`       | `toolInput`         |
| `tool_response`    | `toolOutput`        |

Schemas are `z.looseObject`, so unknown extra fields pass through. Per-event required fields (from `HOOK_INPUT_BRANCHES`) and known asymmetries:

| Event              | Required primaries                           | Notes                                                                     |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------------------- |
| `SessionStart`     | `sessionId`, `cwd`                           | camelCase `sessionId` is required; `session_id` is only an optional alias |
| `UserPromptSubmit` | `prompt`, `cwd`                              | `permission_mode` appears only on this event                              |
| `PreToolUse`       | `toolName`, `toolInput`, `cwd`               | `tool_use_id` stays snake_case (no camelCase primary)                     |
| `PostToolUse`      | `toolName`, `toolInput`, `toolOutput`, `cwd` | No `transcript_path`; `tool_response` aliases to `toolOutput`             |
| `PreCompact`       | `reason`, `cwd`                              | No `accepted` field                                                       |
| `PostCompact`      | `reason`, `cwd`                              | Optional `accepted` boolean                                               |
| `Stop`             | `cwd`                                        | Optional `stopReason`                                                     |

Example `PreToolUse` envelope:

```json
{
  "event": "PreToolUse",
  "toolName": "bash",
  "toolInput": { "command": "ls" },
  "cwd": "/Users/dev/project",
  "session_id": "sess-123"
}
```

After normalization, `session_id` is copied into `sessionId` when the primary was absent. `HOOK_INPUT_BRANCHES` is the drift-pinned field manifest; schemas implement it strictly.

## stdout contract

Gate and block events read one JSON object from handler stdout. Output shape is sourced from the vendored output parser (not the thinner `HookOutputWire` .d.ts). Decision vocabulary is `HOOK_DECISIONS`: `approve`, `block`, `deny`, `ask`, `allow`.

Tool gate (`PreToolUse`):

| Field               | Type                                 | Notes                                                         |
| ------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `decision`          | `allow`, `approve`, `ask`, or `deny` | `block` collapses to `deny`; unknown values are dropped       |
| `reason`            | string, optional                     | Blank/non-string reasons are dropped (no default substituted) |
| `additionalContext` | string, optional                     | Honored when nonblank                                         |
| `updatedInput`      | unknown, optional                    | Applied only when the permission decision is `allow`          |
| `systemMessage`     | string, optional                     | Honored on this event                                         |

```json
{ "decision": "deny", "reason": "command not allowed" }
```

Block gates (`PostToolUse`, `UserPromptSubmit`):

| Field               | Type             | Notes                               |
| ------------------- | ---------------- | ----------------------------------- |
| `decision`          | `block` only     | Any other decision yields a warning |
| `reason`            | string, optional | Dropped when blank                  |
| `additionalContext` | string, optional | Honored when nonblank               |
| `updatedToolOutput` | unknown          | `PostToolUse` only                  |
| `systemMessage`     | string, optional | Honored on these events             |

Stop gate (`Stop`):

| Field               | Type                  | Notes                              |
| ------------------- | --------------------- | ---------------------------------- |
| `decision`          | `block` or `continue` | Other values warn and are dropped  |
| `continue`          | boolean               | `false` forces `decision: "block"` |
| `stopReason`        | string, optional      | Paired with force-stop             |
| `reason`            | string, optional      | Feedback on block                  |
| `additionalContext` | string, optional      | Honored when nonblank              |
| `systemMessage`     | string, optional      | Honored on Stop                    |

```json
{
  "decision": "block",
  "reason": "tasks remain open",
  "additionalContext": "2 tasks incomplete"
}
```

```json
{ "continue": false, "stopReason": "operator requested halt" }
```

Universal parser fields on every event: `continue`, `stopReason`, `suppressOutput`, `systemMessage`. `systemMessage` is kept only for `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, and `Stop`. On `PreCompact`/`PostCompact` it produces an `unsupported_field` warning and is dropped. Nested `hookSpecificOutput` feeds the same fields (and PreToolUse `permissionDecision` / `permissionDecisionReason` / `updatedInput`); a mismatched `hookEventName` discards only the specific-derived fields.

### Exit codes

Consumer-visible process exit from `executeSenpiHook`:

| Code | Meaning                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| `0`  | Handler command ran. Parsed output JSON was written to stdout (blocking outcomes ride in that JSON).              |
| `1`  | Validation failure: stdin timeout, malformed/schema-invalid envelope, or failed command spawn. Nothing on stdout. |

Handler-command result rules (applied before writing stdout; runner still exits 0 when the command itself ran):

| Child result                            | Parsed output                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| exit code `2`                           | `{ decision: "block", reason: <trimmed stderr> }` (reason omitted if blank); stdout ignored |
| other exit, empty stdout                | `{}` (no-op)                                                                                |
| other exit, valid JSON object stdout    | universal + event-specific fields as above                                                  |
| other exit, malformed/non-object stdout | `{}` (no-op) plus `invalid_root` diagnostic on stderr                                       |

Output-parse diagnostics (`invalid_root`, `unsupported_field`, ...) are logged as `[senpi-hook]` lines on stderr and do not change the process exit code.

`SenpiHookOutputBuilder` covers these shapes: `approve()`, `block(reason?)`, `deny(reason?)`, `ask(reason?)`, `context(additionalContext)`, `updatedInput(input)`, `updatedToolOutput(output)`, `forceStop(stopReason?)`, `systemMessage(text)`, plus `success(message?)` and `error(reason)`. Every output round-trips through `senpiHookOutputSchema`. Stop-gate outputs are advanced: kit examples and Cockpit wiring treat Stop as observe-only unless a later phase opts into block/continue with a written loop-safety rationale.

## Runner

`executeSenpiHook(handler, options?)` runs one command hook end to end: `readSenpiStdinJson(options?)` collects stdin (30-second cap, bounded byte read) and validates through `validateSenpiHookInput`, the platform-selected command runs (`commandWindows` on win32 when set), the vendored output-parser rules judge the result, and `outputSenpiJson` writes the typed output. Injectable seams cover stdin/stdout/stderr/exit/platform/`runCommand` for tests.

The senpi path never reads `CLAUDE_*` configuration, never imports grok or Claude modules, and never touches hook trust state.

## Settings validation

`validateSenpiHooksConfig(json)` validates a parsed JSON hooks object. It never throws. Return shape is `{ executableHandlers, diagnostics }` with the pinned `SenpiHookDiagnosticCode` vocabulary.

Handlers are command only:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "hooks": [
          {
            "type": "command",
            "command": "node guard.mjs",
            "timeout": 10,
            "statusMessage": "running guard"
          }
        ]
      }
    ]
  }
}
```

| Field            | Notes                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| `type`           | `command` only; `http`/`prompt`/`agent`/`mcp_tool` → `unsupported_handler_type` |
| `command`        | Required                                                                        |
| `commandWindows` | Optional win32 override                                                         |
| `timeout`        | Seconds; upstream default 600                                                   |
| `statusMessage`  | Optional string                                                                 |
| `matcher`        | Optional group matcher                                                          |

Config event keys must be exactly the 7 names in `SENPI_HOOK_EVENT_NAMES`. Snake_case or camelCase spellings are `unknown_event`. Keys in `SENPI_UNSUPPORTED_HOOK_EVENT_NAMES` are `unsupported_event`. Handler types in `SENPI_UNSUPPORTED_HANDLER_TYPES` are rejected with diagnostics, not executed.

### Config sources (engine discovery)

This library validates parsed config objects; it does not perform discovery. Upstream loads command hooks from:

1. `<agentHome>/hooks.json`
2. `<cwd>/.senpi/hooks.json`
3. `hooks` keys inside settings.json (global `<agentHome>/settings.json` and project `.senpi/settings.json`)

Agent home resolution for consumers is `resolveSenpiAgentHome(options?)`:

1. First non-empty of `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` (`AGENT_DIR_ENV_NAMES`)
2. `<home>/.omo/agent` when it contains `settings.json` (`AGENT_HOME_SENTINEL`)
3. `<home>/.omo` when it contains `settings.json`
4. else `<home>/.senpi/agent`

### Trust gate

Trust inspection is read-only and never writes:

| Export                           | Purpose                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `readSenpiHookTrustState`        | Read `hooks-state.json` without writing                                                  |
| `isSenpiCommandHookTrusted`      | Compare live handler hash to a stored grant                                              |
| `senpiHookTrustId`               | Pure id: `hk_<sourceKeyHash>_<event>_<groupIndex>_<handlerIndex>`                        |
| `senpiHashCommandHook`           | Pure content hash `sha256:<hex>` over the canonical command identity                     |
| `resolveSenpiHookTrustStatePath` | Resolve global `<agentHome>/hooks-state.json` or project `<cwd>/.senpi/hooks-state.json` |
| `SENPI_HOOKS_STATE_FILENAME`     | `hooks-state.json`                                                                       |
| `SENPI_PROJECT_CONFIG_DIR`       | `.senpi`                                                                                 |

Storage paths (engine parity): global `<agentHome>/hooks-state.json`, project `<cwd>/.senpi/hooks-state.json`. Path helpers never default to `~/.omo`.

Mutation is explicit and opt-in. `writeSenpiHookTrustEntry` and `removeSenpiHookTrustEntry` are the grant/revoke acts themselves: callers must pass an options object with `consent: true`, a non-empty `reason`, and an explicit handler/scope/`agentHome`/`cwd` target before any filesystem access. Nothing runs at module import. Failures raise `SenpiTrustConsentError`, `SenpiTrustStateMalformedError`, or `SenpiTrustLockError`. The writer locks, preserves unknown entries, replaces atomically, and is fail-closed on malformed state. Removing the last entry (with no unknown top-level keys) deletes the state file so a grant/revoke cycle is a reversible file delta.

The caller owns consent, the target directory, and uninstall. These helpers are library capability, not a Cockpit product integration. **Cockpit is observe-only** and must not grant or revoke trust.

### Hooks registration

Observe-only registration helpers never write trust and never enable gates:

| Export                        | Purpose                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `buildSenpiHooksRegistration` | Pure builder for a command-only hooks.json document                                          |
| `resolveSenpiHooksConfigPath` | Resolve `{ filePath }` / global `<agentHome>/hooks.json` / project `<cwd>/.senpi/hooks.json` |
| `readSenpiHooksConfig`        | Inspect a target; missing file → `{ ok: true, document: null }`                              |
| `writeSenpiHooksConfig`       | Consent-gated atomic write of that document                                                  |
| `removeSenpiHooksConfig`      | Consent-gated unregister (deletes the file; missing is a no-op)                              |
| `SENPI_HOOKS_CONFIG_FILENAME` | `hooks.json`                                                                                 |
| `SenpiHooksConsentError`      | Thrown before any write when consent, reason, or target is omitted                           |

`writeSenpiHooksConfig` and `removeSenpiHooksConfig` require `{ consent: true, reason, target }`. Positional paths are rejected before any filesystem access. `target` is `{ filePath }`, `{ scope: "global", agentHome }`, or `{ scope: "project", cwd }`. The caller supplies the isolated home; the library never writes `~/.omo` unless that path is passed in explicitly.

### Standalone forwarder assets

`@libar-dev/agent-harness-kit/forwarder` exports pack-relative asset paths. It does not install anything.

| Export                                  | Purpose                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `STANDALONE_HOOK_FORWARDER_ASSET`       | `dist/standalone/hook-forwarder.mjs` (Claude)                   |
| `STANDALONE_SENPI_HOOK_FORWARDER_ASSET` | `dist/standalone/hook-forwarder-senpi.mjs` (Senpi observe-only) |
| `RUN_HOOK_WRAPPER_SH`                   | POSIX wrapper string for Claude endpoint-discovery consumers    |

The Senpi standalone forwarder POSTs a valid envelope to `SENPI_HOOK_FORWARD_URL` and always exits 0 with empty stdout. It never emits a gate decision. Shipping the asset is not an install. Cockpit must not install this forwarder or define a Senpi Stop policy.

## Session layout and processing APIs

On-disk layout:

```
<agentHome>/sessions/<--encoded-cwd-->/
  <timestamp>_<uuid>.jsonl
  <timestamp>_<uuid>-artifacts/   (skipped)
  extensions/                     (skipped)
```

Per-project directory names are dash-encoded cwd paths wrapped as `--...--` (every `/` becomes `-`). Encoding is ambiguous (`/a/b` and `/a-b` share a dirname), so decoding is never attempted. Listing verifies each file's header `cwd`. Session files are top-level `*.jsonl` only.

Discovery and listing exports from `./senpi/processing`:

| Export                                         | Purpose                                        |
| ---------------------------------------------- | ---------------------------------------------- |
| `getSenpiSessionsRoot(agentHome?)`             | Resolve `<agentHome>/sessions`                 |
| `findSenpiSessionDirs(projectCwd, agentHome?)` | Candidate per-cwd directories (may over-match) |
| `listSenpiSessions(projectCwd, options?)`      | Header-cwd-verified sessions for one project   |
| `listAllSenpiSessions(options?)`               | Every session under the agent home             |

`SenpiSessionInfo` fields: `path`, `id`, `cwd`, `name?`, `parentSessionPath?`, `created`, `modified`, `messageCount`, `firstMessage`. Engine parity minus `allMessagesText`. Per-file failures surface as `{ kind: 'invalid', path, error }`, never throw the whole listing.

Parse export:

| Export                 | Purpose                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `parseSenpiEntry(raw)` | Tag-peek dispatch returning `known`, `unknown`, or `invalid`; never throws on unknown/malformed |

Tree and projection exports:

| Export                                       | Purpose                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `resolveSenpiLeaf(entries)`                  | Physical-order leaf selection over a tree index                                           |
| `projectSenpiBranch(entries, leafId, opts?)` | Root-to-leaf active context with compaction handling                                      |
| `computeProjectionMutation(prevKeys, next)`  | Longest-common-prefix splice `{ index, deleteCount, records, removedRecordKeys }` or null |

Tail, watch, checkpoint, and block exports:

| Export                                                     | Purpose                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `tailSenpiSession(file, options?)`                         | One pass: cursor → parse → index → project → splice → reduce                                     |
| `commitSenpiSessionCheckpoint(path, checkpoint, options?)` | Persist a revisioned marker after a successful pass                                              |
| `watchSenpiSession(file, options?)`                        | Async generator; `fs.watch` is a wakeup hint, quiescence is a stable-cursor window (default 30s) |
| `reduceSenpiProjection(previous, current)`                 | Upserts/deletes driven by projection mutations                                                   |
| `foldSenpiBlockChanges(changes)`                           | Fold changes to final `SenpiSessionBlock` values                                                 |

Those 13 value exports are the full `/senpi/processing` runtime surface. JSONL cursor internals and marker schema/filename helpers stay unexported.

Unknown entry tags whose base `{ type, id, parentId, timestamp }` validates join the tree as unknown participants. Malformed known tags are `invalid`, never silently downgraded.

## Tree and compaction semantics

Sessions are branching trees, not linear logs. This library (not the consumer) linearizes each tree into the active root-to-leaf history.

**Persisted-leaf rule.** The leaf is the last complete valid non-header entry in physical file order. Timestamps and childless-node heuristics are not used. `custom`, `label`, `session_info`, `branch_summary`, and unknown-with-valid-base entries all advance the leaf. Live in-engine `/tree` navigation that has not yet been appended to disk is invisible to file-only readers; that gap is intentional and documented as persisted-leaf semantics.

**Compaction.** Only the latest compaction on the active path applies.

- When `retainedTail` is present (including `[]`), it is authoritative: the compaction record plus the retained messages (stable keys `retained:<compaction-id>:<index>`) form the checkpoint, and older prefix entries are disposition `summarized`.
- Legacy sessions without `retainedTail` use `firstKeptEntryId` range inclusion. A missing or off-path first-kept id yields a `missing_first_kept` warning and an incomplete projection.
- Off-path accepted entries are disposition `off_branch` or `summarized`.

**Splice mutations.** Incremental tail emits at most one revisioned suffix splice per pass:

```ts
{
  baseRevision: number;
  revision: number;
  index: number;
  deleteCount: number;
  records: SenpiProjectionRecord[];
  removedRecordKeys: string[];
}
```

Consumers assert their local revision equals `baseRevision`, replace `deleteCount` records at `index` with `records`, then store `revision`. Cold rebuild (invalid or missing marker) emits a full splice from index 0.

**Checkpoint fields** (`SenpiSessionCheckpoint` returned by tail; committed via `commitSenpiSessionCheckpoint`):

| Field                  | Role                                            |
| ---------------------- | ----------------------------------------------- |
| `sessionPathDigest`    | Identity of the session file path               |
| `sessionId`            | Session UUID                                    |
| `device`, `inode`      | Decimal-string file identity                    |
| `generation`           | Identity/content reset counter                  |
| `offset`, `lineNumber` | Byte cursor at a line boundary                  |
| `headDigest`           | SHA-256 of the committed head window            |
| `boundaryDigest`       | SHA-256 at the committed boundary               |
| `baseRevision`         | Expected current marker revision (0 if none)    |
| `leafId`               | Persisted leaf id, or null                      |
| `projectedRecordKeys`  | Ordered active keys for the next LCP comparison |

Marker files are read through a `FileHandle` with a fixed 1 MiB bound. The implementation keeps graph and overflow accounting private and bounded: at most 2048 graph entries / 256 KiB and 2048 projected keys / 256 KiB. Pure append may use that validated private state; branch switches, suffix compaction, absent or invalid state, and other non-append cases rebuild exactly from byte zero. Rebuild work has fixed, non-configurable production bounds of four scans, 128 MiB, and 40,000 lines. When that bound is exhausted, the marker and public byte offset remain unchanged while the existing opaque checkpoint state carries private continuation progress for a later call.

Invalidation (inode change, size below offset, header/digest change, offset not on a line boundary, `fromStart`, malformed marker) forces a cold rebuild. Automatic checkpoint mode writes only after a full successful parse+projection; manual mode returns the checkpoint for the caller to commit.

## Upstream pin and drift policy

Contract artifacts from npm package `@code-yeongyu/senpi` are vendored under `docs/upstream/senpi/`: session-format/settings/environment-variables docs, 21 hooks `.d.ts` files, and the implementation files required for hash/parser/trust-storage parity, plus an MIT `NOTICE`. `pin.json` records `engineVersion: "2026.8.19"`, registry integrity, per-file sha256, and notes. The npm tarball is the artifact of record.

```bash
node scripts/sync-upstream-senpi.mjs --tarball <path-to-npm-pack.tgz> --check
```

`--check` writes nothing. On mismatch it exits non-zero and prints `Senpi upstream vendor drift detected: <file>`. On success it prints `Senpi upstream vendor is in sync.` The drift tests (`tests/senpi-upstream-drift.test.ts`) parse the vendored artifacts both directions (vendored→kit constants/schemas and kit→vendored) and include a mutation-detection case. The sync script is not wired into CI (it needs the tarball); the vendored-only drift tests do run on every push.

## OmO vs senpi naming

OmO native is the branded distribution end users see. The engine underneath is senpi (`@code-yeongyu/senpi`). This kit keeps engine-accurate names:

| Layer                         | Identifier                                      |
| ----------------------------- | ----------------------------------------------- |
| Product / UI copy             | OmO native                                      |
| Kit module subpaths           | `./senpi`, `./senpi/processing`                 |
| Exported type/function prefix | `Senpi*`, `senpi*`, `SENPI_*`                   |
| Agent-home branded path       | `~/.omo/agent` (with `~/.senpi/agent` fallback) |

Do not rename kit APIs to `Omo*`. Downstream product layers may brand as OmO while importing the senpi subpaths.

## Cockpit seam

**Cockpit is observe-only for OmO/Senpi.** This package is a library. Library capability is not product integration.

| Layer                                                                                                                                | Allowed                                                                                                  | Forbidden                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Kit `/senpi` and `/senpi/processing`                                                                                                 | Resolve home, list/tail/watch sessions, validate hook I/O, inspect trust, build a hooks.json document    | Spawn, drive, Commit, RPC                                                                                    |
| Kit mutating primitives (`writeSenpiHooksConfig`, `removeSenpiHooksConfig`, `writeSenpiHookTrustEntry`, `removeSenpiHookTrustEntry`) | Explicit owner/operator tools that pass `{ consent: true, reason, target }` against a directory they own | Module-import side effects; defaulting to `~/.omo`; silent install                                           |
| Cockpit product                                                                                                                      | Dynamic import of observe APIs; read session files for the open project                                  | Register hooks, grant/revoke trust, install the Senpi forwarder, enforce a Senpi Stop gate, write OmO config |

The caller of a mutating primitive owns consent, the target path, and uninstall. Cockpit must not be that caller. Cross-repo product wiring lives outside this package.

## Senpi vs Claude / Grok (no unification)

There is no shared `SessionBlock`, no Claude-to-senpi translator, and no cross-adapter hook-event unification. Write a senpi-native entrypoint with `executeSenpiHook`.

|                        | Claude (root exports)                   | Grok (`./grok`)                         | Senpi (`./senpi`)                                         |
| ---------------------- | --------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| Events                 | 30                                      | 14 wire + legacy alias (15 accepted)    | 7 supported                                               |
| Envelope discriminator | `hook_event_name` PascalCase value      | `hookEventName` snake_case value        | `event` PascalCase (snake alias `hook_event_name`)        |
| Handler types          | command, http, mcp_tool, prompt, agent  | command, http                           | command only                                              |
| PreToolUse decisions   | allow, deny, ask, defer, + updatedInput | allow, deny only                        | allow, approve, ask, deny (+ updatedInput on allow)       |
| Failure / block        | exit 2 blocks                           | fail-open except deny/block JSON/exit 2 | child exit 2 → block JSON; runner exit 0 when command ran |
| Session root           | `~/.claude/projects`                    | `GROK_HOME ?? ~/.grok`                  | `resolveSenpiAgentHome()` → `.../sessions`                |
| Session shape          | single JSONL                            | `updates.jsonl` + `events.jsonl`        | single tree-shaped JSONL (v3)                             |
