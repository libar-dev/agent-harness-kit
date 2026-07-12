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
`watchRawTranscriptRecords` directly should prefer the per-call
`allowedMarkerRoots` tail option over the env var. When the option is set —
even to an empty array — it takes precedence over
`CLAUDE_TAIL_MARKER_ROOTS`; when it is unset, the env var remains the fallback
(which is what the CLI relies on). Per-call roots avoid mutating process-global
state, so concurrent tails across many projects need no coordination:

```ts
await tailRawTranscriptRecords(jsonlPath, {
  markerDir,
  allowedMarkerRoots: [markerDir],
});
```

The public marker-path helper accepts the allow-list as its third argument, so
consumers can resolve or pre-seed the same marker without changing the env var:

```ts
const markerPath = getMarkerPath(jsonlPath, markerDir, [markerDir]);
await writeMarker(markerPath, marker);
```

## Multi-source session API

Library consumers that need the complete live session should pass the main
JSONL path to `tailRawTranscriptSessionRecords`. The function discovers the
main file and `<session-id>/subagents/*.jsonl`, then returns one deterministic
chronological batch without requiring the consumer to know the subagent storage
layout.

```ts
import {
  commitRawTranscriptSessionCheckpoint,
  tailRawTranscriptSessionRecords,
  watchRawTranscriptSessionRecords,
} from '@libar-dev/agent-harness-kit/processing';

const batch = await tailRawTranscriptSessionRecords(mainJsonlPath, {
  markerDir,
  allowedMarkerRoots: [markerDir],
});

for (const record of batch.records) {
  await upsertRecord(record.id, record);
}

for await (const update of watchRawTranscriptSessionRecords(mainJsonlPath, {
  markerDir,
  allowedMarkerRoots: [markerDir],
  pollMs: 500,
  signal: abortController.signal,
})) {
  await ingest(update.records);
}
```

`RawTranscriptSessionTailResult` contains:

- `records`: records from every source, sorted by a source-local effective
  timestamp. A record without its own timestamp inherits the preceding
  timestamp from the same file for sorting only; the returned record and
  payload are not changed. Leading untimestamped records use an empty effective
  key, so they appear before timestamped records in deterministic main/source/
  byte order. Equal effective timestamps use main-before-subagent, source ID,
  byte range, then record ID as stable tie-breakers.
- `sources`: one `RawTranscriptSourceTailResult` per observed file with source
  identity, offsets, rotation state, record count, and parse diagnostics.
- `checkpoint`: serializable per-source offsets for optional durable commit.
- aggregate `invalidJsonLineCount`, `invalidShapeLineCount`, `skippedLineCount`,
  and `degradedHistoryLineCount` values summed from `sources`.

The session marker stores independent source offsets in one atomic checkpoint.
It is written only after every observed source has been read, so a source read
failure leaves the prior checkpoint available for replay. The marker and public
checkpoint carry a SHA-256 digest of the resolved main JSONL path, preventing a
checkpoint or marker from being reused for the same session filename in another
project.

Markers have a monotonic session revision, and each source offset has a
generation. A checkpoint commits only against the exact revision it was derived
from. Normal appends stay in the same generation and cannot move backwards;
truncation advances that source to the next generation, where a shorter offset
is valid. The checkpoint's source list is authoritative for that revision, so a
subagent file that disappeared can be removed safely. Stale revisions and
invalid generation transitions are rejected.

Session-marker mutation is serialized by an atomic `<marker-path>.lock`
directory shared by manual and automatic writers. After acquiring it, the
writer re-reads the marker and performs revision/generation validation inside
the lock before atomically replacing the marker. A competing automatic writer
that discovers its checkpoint is stale leaves the marker untouched and returns
its records; a later pass may replay them, but offsets cannot regress.

Locks are released in a `finally` block after successful writes and validation
or write failures. Acquisition retries for up to five seconds. A lock older than
30 seconds is reclaimed only when its recorded local process is no longer
alive. Abandoned directories are atomically renamed to an owner-identity tombstone;
the tombstone is retained so a delayed competing reclaimer cannot rename a
fresh owner's lock. Marker temporary files use random UUID names, avoiding
sibling collisions.

Owner metadata accepts only the UUID form emitted by `randomUUID()`, a positive
safe-integer PID, and a positive safe-integer creation time within the allowed
clock-skew window. Malformed metadata falls back to directory-stat recovery.
The tombstone suffix is always a fixed SHA-256 digest of validated owner identity
or canonical numeric stat fields; raw owner and filesystem strings are never
interpolated into a path.

Automatic checkpoint commit is the default. Consumers that require
at-least-once delivery across process crashes can defer it until after durable
ingestion:

```ts
const batch = await tailRawTranscriptSessionRecords(mainJsonlPath, {
  markerDir,
  allowedMarkerRoots: [markerDir],
  checkpointMode: 'manual',
});

await durableUpsert(batch.records);
await commitRawTranscriptSessionCheckpoint(mainJsonlPath, batch.checkpoint, {
  markerDir,
  allowedMarkerRoots: [markerDir],
});
```

If the process exits before `commitRawTranscriptSessionCheckpoint` succeeds,
the prior marker remains intact and the batch is replayed. Commits reject stale
checkpoints that would move an existing source offset backwards.

Cold/full scans are bounded to the file size captured before reading. Bytes
appended after that snapshot, including a partial trailing record, remain beyond
the committed offset and are ingested on a later pass.

A version 1 session marker is treated as an untrusted prior checkpoint. The
first version 2 pass safely replays the session, preserving stable record IDs,
then atomically replaces the marker. Later passes resume from the version 2
offsets without another replay.

Each poll rediscovers the subagent directory. Files created after observation
starts are included on the next pass, including when the main file did not
change. `fromStart` applies only to the first watch pass. Abort signals stop the
poll delay without raising an abort error.

The safe raw-record default is unchanged: payload string values and `rawLine`
are redacted. Exact payloads, including tool names and content, require
`rawRedactionMode: 'unsafe-unredacted'`. `dryRun: true` prevents checkpoint
writes; combine it with `fromStart: true` for a side-effect-free historical
preview.

The single-file `tailRawTranscriptRecords` and `watchRawTranscriptRecords` APIs,
including their marker paths and return types, remain unchanged.

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
| `src/processing/index.ts` | Public processing re-exports, including the tail APIs and marker helpers |
