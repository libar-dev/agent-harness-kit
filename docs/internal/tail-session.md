# Tail Claude Code Sessions

Tail a Claude Code session JSONL file and emit only the items that were appended
since the previous successful tail call. Built for live-ingest consumers that
want a structured stream of conversation events as a session grows — vector DB
ingestion, AI processing pipelines, dashboards — without re-reading the whole
file each time.

`claude-session-tail` emits one structured `SessionBlock` per line by default.
A per-session byte-offset marker tracks how far the file has been consumed, so
repeated calls only return new items.

## Quick Start

```bash
# From inside the package directory:
pnpm run tail-session /path/to/session.jsonl

# From anywhere (using --prefix):
pnpm --prefix /path/to/agent-harness-kit run tail-session /path/to/session.jsonl

# Long-running watch mode (emit on each append until Ctrl-C):
pnpm run tail-session /path/to/session.jsonl --watch
```

## Usage

```bash
tsx src/cli/tail-session.ts <session-jsonl-path> [options]
```

The `session-jsonl-path` is an absolute path to a single Claude Code session
`.jsonl` file (for example
`~/.claude/projects/-Users-foo-dev-bar/<session-id>.jsonl`). This is required.

### Modes

There are two modes:

- **One-shot (default).** Emit every new item once, write a single summary line
  to stderr, advance the marker, and exit `0`. Pair this with a notify-style
  file watcher in your consumer: when the file changes, run the CLI again to
  drain the new items.
- **Watch (`--watch` / `-w`).** A long-running process owns the watching loop.
  It watches the file and emits new items on each append (debounced), writing
  one summary line per non-empty pass. It shuts down cleanly on `SIGINT` /
  `SIGTERM` (exit `0`).

### Examples

```bash
# One-shot: drain new blocks since the last call
pnpm run tail-session /path/to/session.jsonl

# Preview without advancing the marker
pnpm run tail-session /path/to/session.jsonl --dry-run

# Re-emit all blocks from the start, ignoring any existing marker
pnpm run tail-session /path/to/session.jsonl --from-start

# Exclude tool_result blocks from the output
pnpm run tail-session /path/to/session.jsonl --no-tool-results

# Long-running watch with a custom debounce window
pnpm run tail-session /path/to/session.jsonl --watch --debounce-ms 500

# Exact, UNREDACTED raw records (see the warning below)
pnpm run tail-session /path/to/session.jsonl --format raw-records --unsafe-raw-unredacted
```

### Running From Other Directories

Use `pnpm --prefix` to run without `cd`-ing into the package directory:

```bash
pnpm --prefix /path/to/agent-harness-kit run tail-session /path/to/session.jsonl --watch
```

**Shell alias** (add to `~/.zshrc` or `~/.bashrc`):

```bash
alias tail-session='pnpm --prefix /path/to/agent-harness-kit run tail-session'
```

Then use simply:

```bash
tail-session /path/to/session.jsonl
tail-session /path/to/session.jsonl --watch
```

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--marker-dir <dir>` | | Directory to store the per-session offset marker (default: `<jsonl-dir>/.tail-markers/`). Custom dirs require `CLAUDE_TAIL_MARKER_ROOTS` (see below). |
| `--dry-run` | | Emit items without advancing the marker (read-only preview). |
| `--from-start` | | Ignore any existing marker and emit all items from byte `0`. In `--watch` this applies only to the first pass. |
| `--no-tool-results` | | Exclude `tool_result` blocks from `blocks` output. |
| `--format <fmt>` | | Output format: `blocks` or `raw-records` (default: `blocks`). |
| `--unsafe-raw-unredacted` | | **Required** with `--format raw-records`. Emits exact, unredacted transcript payloads and `rawLine` bytes. |
| `--watch` | `-w` | Long-running mode: watch the file and emit on each append. |
| `--debounce-ms <n>` | | Debounce window in ms for `--watch` (default: `200`). |
| `--verbose` | `-v` | Pretty progress on stderr in addition to the JSON summary. |
| `--help` | `-h` | Show help. |

## Output

### stdout — one item per line

stdout is a JSONL stream: one item per line, serialized with `JSON.stringify`.
The item shape depends on `--format`:

- `blocks` (default) — one `SessionBlock` per line. These are the same
  discriminated-union blocks the export CLI produces (`session_header`,
  `user_text`, `assistant_text`, `thinking`, `tool_use`, `tool_result`,
  `agent_boundary`). Stable block IDs make consumer-side upserts idempotent.
- `raw-records` — one `RawTranscriptRecord` per line, carrying the original
  line's `payload`, byte range (`byteStart`/`byteEnd`), `lineNumber`, and
  `rawLine` for consumers that own their own interpretation.

In `--watch` mode the stream is open-ended: new lines arrive as the session
grows. In one-shot mode the process emits the current batch and exits.

### stderr — per-pass JSON summary

After each pass, exactly one JSON summary line is written to stderr. One-shot
mode writes one summary before exit; watch mode writes one per non-empty pass
(and, with `--verbose`, one per quiet pass too).

| Field | Type | When present | Description |
|-------|------|--------------|-------------|
| `blockCount` | number | `blocks` format | Number of `SessionBlock`s emitted this pass. |
| `recordCount` | number | `raw-records` format | Number of `RawTranscriptRecord`s emitted this pass. |
| `previousByteOffset` | number | always | Byte offset before this pass (`0` if no marker). |
| `newByteOffset` | number | always | Byte offset reached this pass. |
| `fileSize` | number | always | Total file size at read time. |
| `fileRotated` | boolean | always | `true` if the file shrank since the marker (a full re-scan was performed). |
| `markerAdvanced` | boolean | always | `true` if the marker was written this pass (`false` under `--dry-run`). |
| `invalidJsonLineCount` | number | when `> 0` | Lines that failed JSON parsing. |
| `invalidShapeLineCount` | number | when `> 0` | Lines that parsed as JSON but failed schema validation. |
| `skippedLineCount` | number | when `> 0` | Valid lines intentionally skipped (e.g. unsupported record types). |
| `unsafeRawUnredacted` | `true` | `--unsafe-raw-unredacted` | Flags that the stream contains exact payloads. |
| `warning` | string | `--unsafe-raw-unredacted` | Human-readable warning describing the unsafe exposure. |

With `--verbose`, a human-readable progress line is also written to stderr
before the JSON summary; the JSON summary is always the last stderr line of the
pass so structured consumers can parse it deterministically.

### Marker / offset behavior

A marker file records how far the JSONL has been consumed:

```
<jsonl-dir>/.tail-markers/<session-basename>.json
```

It stores `{ byteOffset, lastTailAt, fileSize }`. On each non-`--dry-run` pass
the marker is advanced to `newByteOffset`. The next call resumes from that
offset (`previousByteOffset`) and emits only the appended items.

- `--dry-run` emits items but never writes the marker (`markerAdvanced: false`).
- `--from-start` ignores the marker and re-emits from byte `0`. In `--watch`,
  this affects only the initial pass; subsequent passes follow the marker.
- **File rotation:** if the file shrinks below the recorded offset (truncated or
  replaced), the pass reports `fileRotated: true` and performs a full re-scan
  from byte `0`.

### `CLAUDE_TAIL_MARKER_ROOTS`

By default the marker lives next to the session file, under `.tail-markers/`.
Claude Code owns `~/.claude/projects/...`, so a consumer that cannot write there
should point `--marker-dir` at its own state directory.

For safety, a custom `--marker-dir` is only honored when it resolves to a path
within an allowed root listed in `CLAUDE_TAIL_MARKER_ROOTS` — a delimiter-
separated list of absolute directories (use the platform `PATH` delimiter: `:`
on POSIX, `;` on Windows). If `CLAUDE_TAIL_MARKER_ROOTS` is unset/empty, or the
resolved `--marker-dir` is outside every allowed root, the CLI errors out.

```bash
# Allow markers under a dedicated state dir, then point --marker-dir at it
export CLAUDE_TAIL_MARKER_ROOTS="$HOME/.local/state/claude-tail"
pnpm run tail-session /path/to/session.jsonl \
  --marker-dir "$HOME/.local/state/claude-tail/markers"
```

This is a processing-CLI environment variable. It is **not** loaded through the
hook `getConfig()` surface and does not appear in the
[environment-variables reference](../reference/environment-variables.md).

#### Library option: `allowedMarkerRoots`

Library consumers calling `tailBlocks` / `tailRawTranscriptRecords` /
`watchRawTranscriptRecords` (or `getMarkerPath`) directly should prefer the
per-call `allowedMarkerRoots` tail option over the env var. When the option is
set — even to an empty array — it takes precedence over
`CLAUDE_TAIL_MARKER_ROOTS`; when it is unset, the env var remains the fallback
(which is what the CLI relies on). Per-call roots avoid mutating process-global
state, so concurrent tails across many projects need no coordination:

```ts
await tailRawTranscriptRecords(jsonlPath, {
  markerDir,
  allowedMarkerRoots: [markerDir],
});
```

### Raw-records safety

> **Warning:** `--format raw-records` requires `--unsafe-raw-unredacted` and
> emits **exact, UNREDACTED** transcript payloads plus the original `rawLine`
> bytes. This can include secrets (API keys, tokens, passwords, URL
> credentials) verbatim. The CLI refuses to run `--format raw-records` without
> the explicit opt-in, and the summary line is flagged with
> `unsafeRawUnredacted: true` and a `warning` string.

The default `blocks` output is the safe path: `tool_result` bodies are passed
through the block extractor's secret redaction (`[REDACTED:*]` placeholders) and
the 200-line truncation cap, matching the structured JSONL export. Use
`--no-tool-results` to drop those bodies entirely.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success (zero or more new items emitted) / clean shutdown in `--watch`. |
| `1` | File not found / read or parse error. |
| `2` | Invalid arguments (e.g. missing path, bad `--format`, `raw-records` without the unsafe opt-in). |

In `--watch` mode, a missing or transiently failing file is retried with
exponential backoff (200 ms up to 30 s) rather than exiting `1`.

## Files

| File | Description |
|------|-------------|
| `src/cli/tail-session.ts` | CLI entry point (argument parsing, watch loop, output) |
| `src/processing/tail.ts` | Tail engine: marker handling, byte offsets, block/record emission, redaction |
| `src/processing/blocks.ts` | `SessionBlock` extraction used by `blocks` output |
| `src/processing/tool-result-redaction.ts` | Secret redaction + truncation for retained tool-result bodies |
| `src/processing/types.ts` | `SessionBlock`, `RawTranscriptRecord`, and tail result type definitions |
| `src/processing/index.ts` | Public re-exports (`tailBlocks`, `tailRawTranscriptRecords`, `watchRawTranscriptRecords`, `readRawSessionFiles`) |
