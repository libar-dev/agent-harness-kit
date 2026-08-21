# Grok Adapter Reference

Grok Build support in `@libar-dev/agent-harness-kit/grok` and `@libar-dev/agent-harness-kit/grok/processing`.

**Sources:** [`src/grok/`](../../src/grok/index.ts), [`src/grok/processing/`](../../src/grok/processing/index.ts), vendored upstream contract files under [`docs/upstream/grok/`](../upstream/grok/NOTICE)

**Scope:** attach-only. The library answers Grok hook calls and reads Grok's on-disk session files. It does not start or drive Grok sessions, and it does not translate Claude hook scripts to Grok.

## Events and gate kinds

Grok fires 14 wire events plus one legacy alias (15 accepted wire values). The `hookEventName` value on stdin is snake_case.

| Wire value              | Gate kind                                   | stdout honored                 |
| ----------------------- | ------------------------------------------- | ------------------------------ |
| `session_start`         | Observe                                     | No                             |
| `user_prompt_submit`    | Observe                                     | No                             |
| `pre_tool_use`          | Tool gate                                   | Yes, `{decision: allow\|deny}` |
| `post_tool_use`         | Observe                                     | No                             |
| `post_tool_use_failure` | Observe                                     | No                             |
| `permission_denied`     | Observe                                     | No                             |
| `stop`                  | Stop gate                                   | Yes, Stop JSON                 |
| `stop_failure`          | Observe                                     | No                             |
| `notification`          | Observe                                     | No                             |
| `subagent_start`        | Observe                                     | No                             |
| `subagent_stop`         | Stop gate                                   | Yes, Stop JSON                 |
| `subagent_end`          | Stop gate (legacy alias of `subagent_stop`) | Yes, Stop JSON                 |
| `pre_compact`           | Observe                                     | No                             |
| `post_compact`          | Observe                                     | No                             |
| `session_end`           | Observe                                     | No                             |

Only `pre_tool_use` is a Tool gate. `stop`, `subagent_stop`, and `subagent_end` are Stop gates. Every other event is Observe: stdout is recorded upstream and any decision JSON is ignored.

The exported `GrokHookEventName` array lists all 15 accepted wire values, and `grokHookInputSchema` validates envelopes for each.

## Envelope contract

All envelopes are camelCase JSON objects read from stdin.

| Field              | Type                                        | Required |
| ------------------ | ------------------------------------------- | -------- |
| `hookEventName`    | snake_case event value from the table above | Yes      |
| `sessionId`        | string                                      | Yes      |
| `cwd`              | string                                      | Yes      |
| `workspaceRoot`    | string                                      | Yes      |
| `timestamp`        | string                                      | Yes      |
| `transcriptPath`   | string                                      | No       |
| `clientIdentifier` | string                                      | No       |
| `promptId`         | string                                      | No       |
| `permissionMode`   | string                                      | No       |

Payload fields sit at the top level of the same object (untagged and flattened upstream). Schemas are `z.looseObject`, so unknown extra fields pass through. Examples of per-event payload fields:

| Event           | Payload fields                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pre_tool_use`  | `toolName`, `toolUseId`, `toolInput` (unknown), `toolInputTruncated` (boolean), `subagentType?`                      |
| `stop`          | `reason`, `stopHookActive`, `lastAssistantMessage?`, `backgroundTasks?`, `sessionCrons?`                             |
| `stop_failure`  | `error`: `rate_limit`, `authentication_failed`, `invalid_request`, `server_error`, `max_output_tokens`, or `unknown` |
| `subagent_stop` | `phase`: `gate` or `observe`, plus subagent identity fields                                                          |

Example `pre_tool_use` envelope:

```json
{
  "hookEventName": "pre_tool_use",
  "sessionId": "sess-123",
  "cwd": "/Users/dev/project",
  "workspaceRoot": "/Users/dev/project",
  "timestamp": "2026-08-13T10:00:00.000Z",
  "toolName": "run_terminal_command",
  "toolUseId": "tool-1",
  "toolInput": { "command": "ls" },
  "toolInputTruncated": false
}
```

`toolInput` and `toolResult` are capped upstream at 128 KiB; oversized values arrive as a string with a ` [truncated]` suffix and the paired `...Truncated` flag set to `true`.

## stdout contract

Gate events read one JSON object from stdout.

Tool gate (`pre_tool_use`):

| Field      | Type              | Notes                                                         |
| ---------- | ----------------- | ------------------------------------------------------------- |
| `decision` | `allow` or `deny` | No `ask`, `defer`, or `updatedInput`                          |
| `reason`   | string, optional  | Blank deny reasons fall back to stderr or an upstream default |

```json
{ "decision": "deny", "reason": "command not allowed" }
```

Stop gates (`stop`, `subagent_stop`, `subagent_end`):

| Field                                  | Type                  | Notes                                  |
| -------------------------------------- | --------------------- | -------------------------------------- |
| `decision`                             | `block` or `approve`  | `block` requires a reason to be useful |
| `reason`                               | string, optional      | Feedback shown on block                |
| `continue`                             | `false` to force-stop | Force-stop overrides blocks            |
| `stopReason`                           | string, optional      | Paired with `continue: false`          |
| `hookSpecificOutput.additionalContext` | string, optional      | Honored only when nonblank             |

```json
{
  "decision": "block",
  "reason": "tasks remain open",
  "hookSpecificOutput": { "additionalContext": "2 tasks incomplete" }
}
```

```json
{ "continue": false, "stopReason": "operator requested halt" }
```

Exit codes follow the usual convention: 0 success, 1 non-blocking error, 2 blocking error. Grok is fail-open: a deny JSON is honored regardless of exit code, an allow is ignored on exit 2, and any other failure (missing handler, timeout, exit 1, unparseable stdout) lets the tool call or stop proceed.

`GrokHookOutputBuilder` covers exactly these shapes: `gateAllow()`, `gateDeny(reason?)`, `stopBlock(reason?)`, `stopApprove()`, `stopForce(stopReason?)`, `stopContext(additionalContext)`, plus the universal `success(message?)` and `error(reason)`. Every output round-trips through `grokGateOutputSchema` or `grokStopOutputSchema`.

## Runner

`executeGrokHook(handler)` mirrors `executeHook` with Grok semantics: `readGrokStdinJson()` collects stdin (30-second cap) and validates through `validateGrokHookInput`, and `outputGrokJson` writes typed outputs. Handler-thrown blocking errors print deny JSON for `pre_tool_use` and block JSON for Stop gates, then exit 2. Unexpected errors exit 1 with a stderr log, which upstream treats as non-blocking. The Grok path never reads `CLAUDE_*` configuration.

## Settings validation

`validateGrokHooksConfig(json)` validates a parsed JSON hooks file; `validateGrokHooksToml(parsedToml)` validates an already-parsed TOML value (TOML parsing stays the consumer's job, for example `smol-toml`). Both normalize event-key aliases to canonical PascalCase keys.

Handlers are command or http only:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_terminal_command",
        "hooks": [
          { "type": "command", "command": "node guard.mjs", "timeout": 10 },
          {
            "type": "http",
            "url": "https://hooks.example.com/pre",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

| Field     | Notes                                                    |
| --------- | -------------------------------------------------------- |
| `type`    | `command` or `http`; no `mcp_tool`, `prompt`, or `agent` |
| `command` | Required for `type: "command"`                           |
| `url`     | Required for `type: "http"`                              |
| `timeout` | Seconds. Upstream defaults: 5s, and 600s for Stop gates  |
| `env`     | `Record<string, string>` or null, optional               |

Event-key aliases accepted on the config side: PascalCase, snake_case, camelCase, and the Cursor-style names `beforeSubmitPrompt` (UserPromptSubmit), `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile` (PreToolUse), `afterShellExecution`, `afterMCPExecution`, `afterFileEdit`, `afterAgentResponse`, `afterAgentThought` (PostToolUse), and `subagentEnd`. Aliases are config-side only; stdin envelopes accept only snake_case wire values.

JSON vs TOML semantics differ by design: JSON validation is fail-fast (any malformed recognized event group rejects the whole file), while TOML validation skips malformed event groups and keeps valid ones, returning `{config, skipped}`.

Upstream discovery order for hooks files: `$GROK_HOME/hooks/*.json` plus the hooks-paths registry, compat reads of `~/.claude/settings(.local).json` and `~/.cursor/hooks.json`, and project `.grok/hooks/` plus `.claude`/`.cursor` project files (trusted projects only). TOML layers are requirements, config, and managed_config. Duplicate entries resolve first-source-wins. This library validates parsed config objects; it does not perform the discovery itself.

## Session layout and processing APIs

On-disk layout:

```
$GROK_HOME/sessions/<encoded-cwd>/<session-id>/
  summary.json
  updates.jsonl
  events.jsonl
  chat_history.jsonl
  plan.json, rewind_points.jsonl, signals.json, subagents/
```

`GROK_HOME` defaults to `~/.grok`. The per-project directory name is the URL-encoded cwd (`%2FUsers%2F...`); when the encoded name exceeds 255 bytes, upstream falls back to `<slug-of-basename>-<first16hex blake3(cwd)>`, and a `.cwd` file inside the directory stores the original path. `updates.jsonl` holds the conversation (ACP `session/update` plus the xAI `_x.ai/session/update` union) and is the resume source of truth; `events.jsonl` holds the `Event` union (snake_case `type` tags, `schema_version: "1.0"` on `turn_started`). `chat_history.jsonl` is a derived cache and is not parsed here.

Discovery exports from `./grok/processing`:

| Export                      | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `getGrokHome(env?)`         | Resolve `GROK_HOME ?? ~/.grok`                           |
| `encodeGrokCwdDirname(cwd)` | URL-encode, with the blake3 slug fallback over 255 bytes |
| `findGrokSessionDirs(cwd)`  | Locate session directories for a project                 |
| `listGrokSessions(cwd)`     | Read `summary.json` entries via `grokSummarySchema`      |

Parse exports:

| Export                        | Purpose                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `grokUpdateEnvelopeSchema`    | `{timestamp, method, params: {sessionId, update, _meta?}}` envelope                        |
| `parseGrokSessionUpdate(raw)` | Tag-peek dispatch returning `known`, `unknown`, or `invalid`; never throws on unknown tags |
| `grokEventSchema`             | Discriminated union over the full `Event` union                                            |
| `parseGrokEvent(raw)`         | Same known/unknown/invalid policy for events                                               |

Tail and reducer exports:

| Export                                   | Purpose                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `tailGrokSession(sessionDir, options?)`  | One pass over both JSONL sources with checkpointing                                    |
| `commitGrokSessionCheckpoint(...)`       | Commit a revisioned marker after both reads succeed                                    |
| `watchGrokSession(sessionDir, options?)` | Async generator on `fs.watch`                                                          |
| `reduceGrokRecords(records)`             | Fold parsed records into `GrokBlockChange` upserts/deletes plus `GrokActivity` entries |
| `foldGrokBlockChanges(changes)`          | Fold changes to final `GrokSessionBlock` values                                        |

Timestamps come from `params._meta.agentTimestampMs ?? timestamp` for updates and `ts` for events; ties break by source kind, then generation, then byte offset. A missing `events.jsonl` reports status `missing`, not an error. `jsonl-cursor` (the bounded line reader with inode-reset handling) is internal and not exported from the barrel.

Unknown `sessionUpdate` and event tags are preserved as unknown native records, never fatal. Malformed known variants are reported as invalid, never silently downgraded.

## Rewind divergence (intentional)

The reducer in `src/grok/processing/blocks.ts` treats `rewind_marker` as strictly-after: it deletes blocks whose prompt index is greater than `target_prompt_index` and keeps the block at the target index itself. Upstream `replay.rs` implements rewind-before prompt N, dropping indexes greater than or equal to N. Example: with prompts at indexes 1, 2, 3 and a `rewind_marker` with `target_prompt_index: 2`, this library deletes prompt 3 only, while upstream replay deletes prompts 2 and 3. This divergence is deliberate per the approved plan contract; it lives in `rewindBlocks` in `src/grok/processing/blocks.ts`.

## Upstream pin and drift policy

Six contract files from `xai-org/grok-build` are vendored under `docs/upstream/grok/`: `event.rs`, `result.rs`, `runner-mod.rs`, `session-events-types.rs`, `plugins-types-lib.rs`, and `session-update-enum.txt`, with an Apache-2.0 `NOTICE` and `LICENSE-APACHE`. `pin.json` records repo, `HEAD` (`e5fd4816d43260c15ba785f103990c1ed6cea230`), `SOURCE_REV` (`ea094a8c369475f97c85540d01730baec0dce5d6`), `grok --version` 1.0.3, and per-file sha256.

`node scripts/sync-upstream-grok.mjs <checkout> --check` exits non-zero and names the drifted file if a vendored copy no longer matches. The drift tests (`tests/grok-upstream-drift.test.ts`) parse the vendored Rust sources and assert the TypeScript event-name list, wire values, and event-union branches match exactly.

## Grok vs Claude incompatibility matrix

There is no 30-event parity, no Claude-to-Grok translator, and no shared `SessionBlock` unification. Claude hook scripts will not run correctly under Grok without a Grok-native entrypoint: they read snake_case fields Grok never sends and can emit decision vocabularies Grok ignores. Write a separate Grok script with `executeGrokHook`.

|                      | Claude (root exports)                        | Grok (`./grok` exports)                                              |
| -------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Events               | 30                                           | 14 wire events plus legacy `subagent_end` (15 accepted wire values)  |
| Envelope keys        | snake_case (`hook_event_name`)               | camelCase (`hookEventName`)                                          |
| Event value on stdin | PascalCase (`PreToolUse`)                    | snake_case (`pre_tool_use`)                                          |
| Tool I/O fields      | `tool_input`, `tool_response`                | `toolInput`, `toolResult`                                            |
| PreToolUse decisions | allow, deny, ask, defer, plus `updatedInput` | allow and deny only                                                  |
| Handler types        | command, http, mcp_tool, prompt, agent       | command and http only                                                |
| Default timeouts     | 600s command/http (library runner 60s)       | 5s default, 600s Stop gates                                          |
| Failure policy       | exit 2 blocks                                | fail-open except explicit deny, Stop block JSON, or exit 2           |
| Session root         | `~/.claude/projects` (dash-encoded cwd)      | `GROK_HOME ?? ~/.grok` (URL-encoded cwd, blake3 slug over 255 bytes) |
| Session transcript   | single JSONL                                 | `updates.jsonl` plus `events.jsonl`                                  |
