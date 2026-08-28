# Senpi session fixtures

Fixtures for the OmO-native / senpi attach adapter (session JSONL v3).

Entry shape authority: `docs/upstream/senpi/session-format.md` (pin 2026.8.19).

## Layout

| File | Kind | Purpose |
| --- | --- | --- |
| `redact.mjs` | tool | Deterministic redaction: real session JSONL → `real-*.jsonl` |
| `real-6604bde4.jsonl` | real (redacted) | Compaction ×2, dense custom/custom_message/message traffic |
| `real-0a3e733b.jsonl` | real (redacted) | Compaction ×1 + `session_info`, todo-state heavy |
| `real-d54ba25d.jsonl` | real (redacted) | Compaction ×1 + `session_info`, thinking_level_change density |
| `synthetic-branch-switch.jsonl` | synthetic | Sibling branches + `branch_summary` after switch |
| `synthetic-retained-tail-compaction.jsonl` | synthetic | Compaction with `retainedTail` checkpoint |
| `synthetic-legacy-first-kept-compaction.jsonl` | synthetic | Compaction with legacy `firstKeptEntryId` only |
| `synthetic-duplicate-id.jsonl` | synthetic | Same entry `id` appears twice |
| `synthetic-orphan-parent.jsonl` | synthetic | `parentId` references a missing id |
| `synthetic-multi-root.jsonl` | synthetic | Two independent `parentId: null` roots |
| `synthetic-header-only.jsonl` | synthetic | Session header, no tree entries |
| `synthetic-empty.jsonl` | synthetic | Zero-byte / empty file |
| `synthetic-unicode-cwd.jsonl` | synthetic | Non-ASCII `cwd` + synthetic `session_info` / `label` |

## Real transcript provenance

Sources are read **read-only** from the local agent session store. Nothing under the agent home is modified by this tool.

Exact source paths and original session UUIDs are **not** recorded in-tree (public repo). Maintainers regenerate fixtures by supplying local paths as CLI args:

```text
~/.omo/agent/sessions/--Users-<user>-<project>--/<timestamp>_<session-uuid>.jsonl
```

(uuid withheld; choose sessions with at least one `compaction` entry; branch coverage is synthetic because the capture store had no `branch_summary` / parentId fan-out.)

| Fixture | Capture notes |
| --- | --- |
| `real-6604bde4.jsonl` | 2× `compaction` (`firstKeptEntryId`); dense custom types |
| `real-0a3e733b.jsonl` | 1× `compaction`; `session_info` present; todo-state heavy |
| `real-d54ba25d.jsonl` | 1× `compaction`; `session_info` present; thinking_level_change density |

**Branch traffic:** synthetic only — `synthetic-branch-switch.jsonl`.

**Labels:** no `label` entries existed in the capture store. Label redaction is implemented in `redact.mjs`; synthetic fixtures carry fixture-only label strings.

## Redaction policy (`redact.mjs`)

Deterministic, content-hash stubs (no wall-clock). Rerunning against the same sources yields **byte-identical** fixtures.

| Category | Treatment |
| --- | --- |
| Message text / thinking / tool args & outputs | `[redacted:<kind>:<sha16>]` |
| `custom.data` (incl. `senpi.todo-state`) | deep type-preserving stub of all string leaves; keys + customType kept |
| `custom_message` content | stubbed |
| `session_info.name` | stubbed |
| `label.label` | stubbed |
| Compaction / branch_summary `summary` + details | stubbed |
| `retainedTail` messages | same message redaction |
| Session UUID (`header.id`, embedded session ids) | mapped to stable synthetic UUID |
| cwd / home / username path segments | `/Users/<user>` → `/Users/fixture-user` |
| Entry tree ids (`id` / `parentId` 8-char hex) | kept (structural) |
| provider / model / usage / timestamps / tool names | kept |

```bash
node tests/fixtures/senpi/redact.mjs \
  ~/.omo/agent/sessions/--Users-<user>-<project>--/<timestamp>_<session-uuid>.jsonl \
  [more-sources...] \
  --out tests/fixtures/senpi
```

## Privacy gate

Before treating fixtures as shippable, multi-sample fixed-string greps over **every file** under this directory (not only `*.jsonl`) must return **zero** hits for:

1. Machine username
2. Literal `$HOME` path prefix (`/Users/<user>`)
3. ≥3 distinct substrings sampled from each source category present in the redacted sources: message text, `custom.data`, `session_info.name` (and label strings when sources contain labels)
4. Original session UUIDs

Evidence log (local): `.omo/evidence/task-14-fixtures.log`.

## Synthetic fixture notes

Hand-authored minimal JSONL. Strings are fixture prose only (no real user content). Format follows vendored `session-format.md`.
