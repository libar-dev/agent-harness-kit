#!/usr/bin/env node
/**
 * Tail a Claude Code session JSONL file — emit blocks or raw records added
 * since the previous successful tail call.
 *
 * Two modes:
 *   - Default (one-shot):  emit new items once, exit 0
 *   - --watch (long-running): watch the file, emit new items on each append
 *
 * Output contract (both modes):
 *   stdout: one `SessionBlock` or `RawTranscriptRecord` per line as JSONL
 *   stderr: per-pass summary as a single JSON line:
 *           blocks: { blockCount, previousByteOffset, newByteOffset, fileSize,
 *                     fileRotated, markerAdvanced }
 *           raw-records: { recordCount, previousByteOffset, newByteOffset,
 *                          fileSize, fileRotated, markerAdvanced }
 *
 * In watch mode, multiple summary lines are written (one per pass). In one-shot
 * mode, exactly one summary line is written before exit.
 *
 * Exit codes:
 *   0 — success (zero or more new items emitted) / clean SIGINT shutdown in --watch
 *   1 — file not found / read error
 *   2 — invalid arguments
 *
 * Intended for consumers that spawn this from any language (Rust, Go, shell).
 * In one-shot mode, pair with notify-style file watchers in the consumer.
 * In --watch mode, this process owns the watching loop and the consumer
 * streams stdout.
 */

import { parseArgs } from 'node:util';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { once } from 'node:events';
import {
  tailRawTranscriptRecords,
  tailBlocks,
  type RawTranscriptRecord,
  type RawTranscriptTailResult,
  type SessionBlock,
  type TailResult,
} from '../processing/index.js';
import { getMarkerPath, writeMarker } from '../processing/internal.js';

const cliArgs = process.argv.slice(2).filter(a => a !== '--');

class CliArgumentError extends Error {}

let args: ReturnType<typeof parseArgs>['values'];
let positionals: string[];
try {
  const parsed = parseArgs({
    args: cliArgs,
    options: {
      'marker-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'from-start': { type: 'boolean' },
      'no-tool-results': { type: 'boolean' },
      'unsafe-raw-unredacted': { type: 'boolean' },
      format: { type: 'string' },
      watch: { type: 'boolean', short: 'w' },
      'debounce-ms': { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: true,
  });
  args = parsed.values;
  positionals = parsed.positionals;
} catch (err) {
  process.stderr.write(
    `Argument error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(2);
}

if (args['help'] === true) {
  printUsage();
  process.exit(0);
}

const jsonlPath = positionals[0];
if (!jsonlPath) {
  process.stderr.write('Missing required argument: <session-jsonl-path>\n');
  printUsage();
  process.exit(2);
}

main(jsonlPath, args).catch(err => {
  process.stderr.write(
    `Error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(err instanceof CliArgumentError ? 2 : 1);
});

type CliArgs = ReturnType<typeof parseArgs>['values'];

interface TailOpts {
  markerDir?: string;
  dryRun?: boolean;
  fromStart?: boolean;
  includeToolResults?: boolean;
  rawRedactionMode?: 'unsafe-unredacted';
}

type OutputFormat = 'blocks' | 'raw-records';

function buildTailOpts(cliArgs: CliArgs): TailOpts {
  const opts: TailOpts = {};
  const markerDir = cliArgs['marker-dir'];
  if (typeof markerDir === 'string' && markerDir.length > 0) {
    opts.markerDir = markerDir;
  }
  if (cliArgs['dry-run'] === true) opts.dryRun = true;
  if (cliArgs['from-start'] === true) opts.fromStart = true;
  if (cliArgs['no-tool-results'] === true) opts.includeToolResults = false;
  if (cliArgs['unsafe-raw-unredacted'] === true) {
    opts.rawRedactionMode = 'unsafe-unredacted';
  }
  return opts;
}

async function main(path: string, cliArgs: CliArgs): Promise<void> {
  const tailOpts = buildTailOpts(cliArgs);
  const format = parseOutputFormat(cliArgs['format']);
  ensureExplicitUnsafeRawOptIn(format, cliArgs);
  const verbose = cliArgs['verbose'] === true;
  const watchMode = cliArgs['watch'] === true;

  if (watchMode) {
    await runWatch(path, cliArgs, tailOpts, verbose, format);
    return;
  }

  // One-shot mode
  const result = await runTail(path, getReadTailOpts(tailOpts), format);
  await emitItems(getOutputItems(result));
  const markerAdvanced = await commitMarker(path, tailOpts, result);
  // Source of truth for the unsafe warning is the actual redaction mode, not
  // the format — only --unsafe-raw-unredacted exposes raw payloads.
  emitSummary(
    result,
    markerAdvanced,
    verbose,
    tailOpts.rawRedactionMode === 'unsafe-unredacted'
  );
}

// Watch mode: long-running output on each append.

async function runWatch(
  path: string,
  cliArgs: CliArgs,
  tailOpts: TailOpts,
  verbose: boolean,
  format: OutputFormat
): Promise<void> {
  const debounceMsArg = cliArgs['debounce-ms'];
  const debounceMs =
    typeof debounceMsArg === 'string'
      ? parseNonNegativeInt('--debounce-ms', debounceMsArg)
      : 200;
  const minBackoffMs = 200;
  const maxBackoffMs = 30_000;
  let backoffMs = minBackoffMs;

  // After the first pass, we never want to re-emit from start on subsequent
  // passes — the marker takes over. Strip --from-start from per-pass opts.
  const passOpts: TailOpts = { ...tailOpts };
  delete passOpts.fromStart;

  let timer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let pendingAfterInFlight = false;
  let stopped = false;
  let watcher: FSWatcher | null = null;

  const closeWatcher = (): void => {
    watcher?.close();
    watcher = null;
  };

  const resetBackoff = (): void => {
    backoffMs = minBackoffMs;
  };

  const scheduleRetry = (
    reason: string,
    retryOpts: TailOpts = passOpts
  ): void => {
    if (stopped || retryTimer !== null) return;
    closeWatcher();
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    if (verbose) {
      process.stderr.write(`tail: ${reason}; retrying in ${String(delay)}ms\n`);
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      startWatcher();
      triggerPass(retryOpts);
    }, delay);
  };

  const triggerPass = (opts: TailOpts = passOpts): void => {
    if (stopped) return;
    if (inFlight) {
      pendingAfterInFlight = true;
      return;
    }
    inFlight = runOnePass(path, opts, verbose, format)
      .then(result => {
        resetBackoff();
        if (result.fileRotated && !stopped) {
          closeWatcher();
          startWatcher();
        }
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        if (isEnoentError(err)) {
          scheduleRetry(`session file not found (${message})`, opts);
          return;
        }
        process.stderr.write(`Error during watch pass: ${message}\n`);
        scheduleRetry(`watch pass failed (${message})`, opts);
      })
      .finally(() => {
        inFlight = null;
        if (pendingAfterInFlight && !stopped) {
          pendingAfterInFlight = false;
          // Re-arm immediately for the coalesced trailing event
          triggerPass();
        }
      });
  };

  const startWatcher = (): void => {
    if (stopped || watcher !== null) return;
    try {
      watcher = fsWatch(path, { persistent: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(triggerPass, debounceMs);
      });
      watcher.on('error', err => {
        scheduleRetry(`watcher error (${err.message})`);
      });
      resetBackoff();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scheduleRetry(`watcher setup failed (${message})`);
    }
  };

  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (retryTimer) clearTimeout(retryTimer);
    clearInterval(safetyPoll);
    closeWatcher();
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // already logged
      }
    }
    if (verbose) process.stderr.write('tail: shutdown clean\n');
    process.exit(0);
  };

  const handleShutdownSignal = (signal: NodeJS.Signals): void => {
    void shutdown().catch(err => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error during shutdown (${signal}): ${message}\n`);
      process.exit(1);
    });
  };

  process.once('SIGINT', () => {
    handleShutdownSignal('SIGINT');
  });
  process.once('SIGTERM', () => {
    handleShutdownSignal('SIGTERM');
  });

  if (verbose) {
    process.stderr.write(
      `tail: watching ${path} (debounce ${String(debounceMs)}ms)\n`
    );
  }

  startWatcher();
  // Initial pass — honors --from-start if provided.
  triggerPass(tailOpts);

  // Periodic safety-net poll (every 2s) in case fs.watch misses an event.
  // No-op when nothing changed.
  const safetyPoll = setInterval(() => {
    if (!stopped) triggerPass();
  }, 2000);
  safetyPoll.unref();

  // Keep the event loop alive — fs.watch + safetyPoll reference handles do
  // this implicitly, but make it explicit for clarity.
  await new Promise(() => {
    /* never resolves; shutdown calls process.exit */
  });
}

async function runOnePass(
  path: string,
  tailOpts: TailOpts,
  verbose: boolean,
  format: OutputFormat
): Promise<TailResult | RawTranscriptTailResult> {
  const result = await runTail(path, getReadTailOpts(tailOpts), format);
  if (
    getOutputItems(result).length === 0 &&
    !result.fileRotated &&
    !hasProcessingCounts(result)
  ) {
    // Quiet pass: still emit the summary so consumers can track liveness,
    // but only when verbose. Otherwise, swallow no-op passes in watch mode.
    if (verbose) {
      emitSummary(
        result,
        tailOpts.dryRun !== true,
        true,
        tailOpts.rawRedactionMode === 'unsafe-unredacted'
      );
    }
    return result;
  }
  await emitItems(getOutputItems(result));
  const markerAdvanced = await commitMarker(path, tailOpts, result);
  // Source of truth for the unsafe warning is the actual redaction mode, not
  // the format — only --unsafe-raw-unredacted exposes raw payloads.
  emitSummary(
    result,
    markerAdvanced,
    verbose,
    tailOpts.rawRedactionMode === 'unsafe-unredacted'
  );
  return result;
}

// Output helpers.

async function runTail(
  path: string,
  tailOpts: TailOpts,
  format: OutputFormat
): Promise<TailResult | RawTranscriptTailResult> {
  if (format === 'raw-records') {
    return await tailRawTranscriptRecords(path, tailOpts);
  }
  return await tailBlocks(path, tailOpts);
}

function getOutputItems(
  result: TailResult | RawTranscriptTailResult
): readonly SessionBlock[] | readonly RawTranscriptRecord[] {
  return 'records' in result ? result.records : result.blocks;
}

async function emitItems(
  items: readonly SessionBlock[] | readonly RawTranscriptRecord[]
): Promise<void> {
  for (const item of items) {
    await writeStdout(`${JSON.stringify(item)}\n`);
  }
}

function getReadTailOpts(tailOpts: TailOpts): TailOpts {
  if (tailOpts.dryRun === true) {
    return tailOpts;
  }

  return {
    ...tailOpts,
    dryRun: true,
  };
}

async function commitMarker(
  path: string,
  tailOpts: TailOpts,
  result: TailResult | RawTranscriptTailResult
): Promise<boolean> {
  if (tailOpts.dryRun === true) {
    return false;
  }

  await writeMarker(getMarkerPath(path, tailOpts.markerDir), {
    byteOffset: result.newByteOffset,
    lastTailAt: new Date().toISOString(),
    fileSize: result.fileSize,
  });
  return true;
}

async function writeStdout(chunk: string): Promise<void> {
  if (!process.stdout.write(chunk)) {
    await once(process.stdout, 'drain');
  }
}

function emitSummary(
  result: {
    blocks?: readonly SessionBlock[];
    records?: readonly RawTranscriptRecord[];
    previousByteOffset: number;
    newByteOffset: number;
    fileSize: number;
    fileRotated: boolean;
    invalidJsonLineCount: number;
    invalidShapeLineCount: number;
    skippedLineCount: number;
  },
  markerAdvanced: boolean,
  verbose: boolean,
  unsafeRawUnredacted: boolean = false
): void {
  const itemCount = result.records?.length ?? result.blocks?.length ?? 0;
  const summary = {
    ...(result.records === undefined
      ? { blockCount: result.blocks?.length ?? 0 }
      : { recordCount: result.records.length }),
    previousByteOffset: result.previousByteOffset,
    newByteOffset: result.newByteOffset,
    fileSize: result.fileSize,
    fileRotated: result.fileRotated,
    markerAdvanced,
    ...(result.invalidJsonLineCount > 0
      ? { invalidJsonLineCount: result.invalidJsonLineCount }
      : {}),
    ...(result.invalidShapeLineCount > 0
      ? { invalidShapeLineCount: result.invalidShapeLineCount }
      : {}),
    ...(result.skippedLineCount > 0
      ? { skippedLineCount: result.skippedLineCount }
      : {}),
    ...(unsafeRawUnredacted
      ? {
          unsafeRawUnredacted: true,
          warning:
            'UNSAFE raw-records mode exposes exact transcript payloads and rawLine bytes.',
        }
      : {}),
  };
  if (verbose) {
    if (unsafeRawUnredacted) {
      process.stderr.write(
        'tail: WARNING unsafe raw-records mode exposes exact transcript payloads and rawLine bytes\n'
      );
    }
    process.stderr.write(
      `tail: ${String(itemCount)} new ${result.records ? 'records' : 'blocks'} ` +
        `(offset ${String(result.previousByteOffset)} → ${String(result.newByteOffset)}` +
        `${result.fileRotated ? ', file rotated' : ''}` +
        `${formatSummaryCounts(result)}` +
        `${markerAdvanced ? ')' : ', marker NOT advanced)'}\n`
    );
  }
  process.stderr.write(`${JSON.stringify(summary)}\n`);
}

function formatSummaryCounts(result: {
  invalidJsonLineCount: number;
  invalidShapeLineCount: number;
  skippedLineCount: number;
}): string {
  const parts: string[] = [];
  if (result.invalidJsonLineCount > 0) {
    parts.push(`invalid JSON ${String(result.invalidJsonLineCount)}`);
  }
  if (result.invalidShapeLineCount > 0) {
    parts.push(`invalid shape ${String(result.invalidShapeLineCount)}`);
  }
  if (result.skippedLineCount > 0) {
    parts.push(`skipped ${String(result.skippedLineCount)}`);
  }

  return parts.length === 0 ? '' : `, ${parts.join(', ')}`;
}

function hasProcessingCounts(result: {
  invalidJsonLineCount: number;
  invalidShapeLineCount: number;
  skippedLineCount: number;
}): boolean {
  return (
    result.invalidJsonLineCount > 0 ||
    result.invalidShapeLineCount > 0 ||
    result.skippedLineCount > 0
  );
}

function parseOutputFormat(raw: unknown): OutputFormat {
  if (raw === undefined) return 'blocks';
  if (raw === 'blocks' || raw === 'raw-records') return raw;
  throw new CliArgumentError('--format must be one of: blocks, raw-records');
}

function ensureExplicitUnsafeRawOptIn(
  format: OutputFormat,
  cliArgs: CliArgs
): void {
  if (format !== 'raw-records') return;
  if (cliArgs['unsafe-raw-unredacted'] === true) return;
  throw new CliArgumentError(
    '--format raw-records requires --unsafe-raw-unredacted because it exposes exact transcript payloads'
  );
}

function printUsage(): void {
  process.stderr.write(`
Tail a Claude Code session JSONL — emit only blocks since last call.

Usage:
  claude-session-tail <session-jsonl-path> [options]

Arguments:
  session-jsonl-path        Absolute path to a Claude Code session .jsonl

Options:
      --marker-dir <dir>    Where to store the per-session offset marker
                            (default: <jsonl-dir>/.tail-markers/)
      --dry-run             Emit blocks without advancing the marker
      --from-start          Ignore existing marker and emit all blocks
      --no-tool-results    Exclude tool_result blocks from JSONL output
      --format <format>     Output format: blocks | raw-records (default: blocks)
      --unsafe-raw-unredacted
                            Required with --format raw-records; emits exact transcript payloads
  -w, --watch               Long-running mode: watch file, emit on each append
      --debounce-ms <n>     Debounce window for --watch (default: 200)
  -v, --verbose             Pretty progress on stderr
  -h, --help                Show this help

Output:
  stdout  one SessionBlock or RawTranscriptRecord per line as JSONL
  stderr  per-pass JSON summary line:
          blocks: { blockCount, previousByteOffset, newByteOffset, fileSize,
                    fileRotated, markerAdvanced }
          raw-records: { recordCount, previousByteOffset, newByteOffset,
                         fileSize, fileRotated, markerAdvanced }

Exit codes:
  0   success / clean SIGINT shutdown in --watch
  1   read/parse error
  2   invalid arguments
`);
}

function parseNonNegativeInt(optionName: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new CliArgumentError(`${optionName} must be a non-negative integer`);
  }
  return Number(raw);
}

function isEnoentError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
