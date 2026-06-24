#!/usr/bin/env node
/**
 * Export Claude Code sessions as clean markdown and/or structured JSONL.
 *
 * After install, available as:
 *   claude-session-export [project-path] [options]
 *
 * For dev-time usage:
 *   pnpm run export-sessions
 *
 * Output formats:
 *   - markdown: human-readable .md
 *   - jsonl:    structured SessionBlock records — for downstream DB / AI ingestion
 *   - both:     emits both per session (default)
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseArgs } from 'node:util';

import {
  discoverSessions,
  projectDirFromCwd,
  listProjects,
  cwdFromProjectDir,
  resolveProjectPath,
  readExportMarker,
  writeExportMarker,
  readSessionFiles,
  denoiseSession,
  toExportMarkdown,
  extractBlocks,
  toJsonlBlocks,
  type SessionInfo,
  type ExportConfig,
} from '../processing/index.js';

type ExportFormat = 'markdown' | 'jsonl' | 'both';
type FilenameStyle = 'date' | 'webui';

class CliArgumentError extends Error {}

const cliArgs = process.argv.slice(2).filter(a => a !== '--');

const { values: args, positionals } = parseArgs({
  args: cliArgs,
  options: {
    project: { type: 'string', short: 'p' },
    'project-dir': { type: 'string', short: 'P' },
    out: { type: 'string', short: 'o' },
    days: { type: 'string', short: 'd' },
    new: { type: 'boolean', short: 'n' },
    limit: { type: 'string', short: 'l' },
    'list-projects': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    'no-tools': { type: 'boolean' },
    'no-tool-results': { type: 'boolean' },
    'no-thinking': { type: 'boolean' },
    'no-timestamps': { type: 'boolean' },
    'mark-exported': { type: 'boolean', default: true },
    format: { type: 'string', short: 'f' },
    'filename-style': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
  allowPositionals: true,
});

const projectArg = args.project ?? positionals[0];

async function main(): Promise<void> {
  if (args.help === true) {
    printUsage();
    return;
  }

  if (args['list-projects'] === true) {
    await listAvailableProjects();
    return;
  }

  const days =
    typeof args.days === 'string'
      ? parseNonNegativeInt('--days', args.days)
      : undefined;
  const limit =
    typeof args.limit === 'string'
      ? parseNonNegativeInt('--limit', args.limit)
      : undefined;
  const format = parseFormat(args.format);
  const filenameStyle = parseFilenameStyle(args['filename-style']);

  const projectDir = await resolveProjectDir();
  if (!projectDir) {
    console.error(
      'Could not resolve project directory. Use --project or --project-dir.'
    );
    process.exit(1);
  }

  const resolvedPath = await resolveProjectPath(projectDir);
  const displayPath = resolvedPath
    ? resolvedPath.replace(process.env['HOME'] ?? '', '~')
    : cwdFromProjectDir(basename(projectDir));
  console.log(`Project: ${displayPath}`);
  console.log(`Storage: ${projectDir}\n`);

  const after =
    days !== undefined
      ? new Date(Date.now() - days * 86_400_000).toISOString()
      : undefined;

  const sessions = await discoverSessions(projectDir, {
    after,
    sinceLastExport: args.new === true,
    limit,
  });

  if (sessions.length === 0) {
    const lastExport = await readExportMarker(projectDir);
    if (args.new === true && lastExport) {
      console.log(`No new sessions since last export (${lastExport}).`);
    } else {
      console.log('No sessions found matching criteria.');
    }
    return;
  }

  console.log(`Found ${String(sessions.length)} session(s):\n`);
  for (const s of sessions) {
    const date = new Date(s.startTime).toLocaleString();
    const sizeKB = Math.round(s.fileSize / 1024);
    const agents = s.hasSubagents ? ' + agents' : '';
    console.log(
      `  ${s.sessionId.substring(0, 8)}  ${date}  ${String(sizeKB)}KB${agents}`
    );
  }

  if (args['dry-run'] === true) {
    console.log('\n(dry run — no files written)');
    return;
  }

  const outDir =
    typeof args.out === 'string'
      ? args.out
      : await resolveOutputDirAsync(projectDir);
  await mkdir(outDir, { recursive: true });

  console.log(`\nExporting to: ${outDir}\n`);

  const exportConfig: Partial<ExportConfig> = {
    includeTools: !args['no-tools'],
    includeThinking: !args['no-thinking'],
    includeTimestamps: !args['no-timestamps'],
  };

  const wantMd = format === 'markdown' || format === 'both';
  const wantJsonl = format === 'jsonl' || format === 'both';

  let totalSize = 0;
  for (const session of sessions) {
    const label = session.sessionId.substring(0, 8);
    process.stdout.write(`  ${label} ...`);

    try {
      const writes = await exportSingleSession(session, exportConfig, {
        wantMd,
        wantJsonl,
      });
      const baseName = buildFilename(
        session,
        filenameStyle,
        resolvedPath ?? projectDir
      );
      const writtenLabels: string[] = [];
      let sessionBytes = 0;

      if (writes.markdown !== undefined) {
        const filename = `${baseName}.md`;
        await writeFile(join(outDir, filename), writes.markdown);
        sessionBytes += writes.markdown.length;
        writtenLabels.push(filename);
      }
      if (writes.jsonl !== undefined) {
        const filename = `${baseName}.jsonl`;
        await writeFile(join(outDir, filename), writes.jsonl);
        sessionBytes += writes.jsonl.length;
        writtenLabels.push(filename);
      }

      totalSize += sessionBytes;
      const sizeKB = Math.round(sessionBytes / 1024);
      console.log(` ${String(sizeKB)}KB → ${writtenLabels.join(', ')}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(` ERROR: ${message}`);
    }
  }

  if (args['mark-exported'] !== false) {
    await writeExportMarker(projectDir);
  }

  const totalKB = Math.round(totalSize / 1024);
  console.log(
    `\nDone. ${String(sessions.length)} session(s), ${String(totalKB)}KB total.`
  );
  console.log(
    `Export marker updated — use --new next time for incremental export.`
  );
}

async function exportSingleSession(
  session: SessionInfo,
  exportConfig: Partial<ExportConfig>,
  formats: { wantMd: boolean; wantJsonl: boolean }
): Promise<{ markdown?: string; jsonl?: string }> {
  const raw = await readSessionFiles(session.projectDir, session.sessionId);
  const clean = denoiseSession(raw, {
    includeThinking: true,
    includeSubagents: true,
    includeToolSummaries: true,
    includeToolResults: false,
    includeErrors: true,
    maxAssistantBlockLength: 10000,
    maxUserMessageLength: 5000,
  });

  const out: { markdown?: string; jsonl?: string } = {};
  if (formats.wantMd) {
    out.markdown = toExportMarkdown(clean, {
      ...exportConfig,
      sessionInfo: session,
    });
  }
  if (formats.wantJsonl) {
    const blocks = extractBlocks(raw, {
      parsed: clean,
      includeToolResults: args['no-tool-results'] !== true,
    });
    out.jsonl = toJsonlBlocks(blocks);
  }
  return out;
}

function buildFilename(
  session: SessionInfo,
  style: FilenameStyle,
  projectPath: string
): string {
  const shortId = session.sessionId.substring(0, 8);
  if (style === 'webui') {
    const last = projectPath.replace(/\/$/, '').split('/').pop() ?? 'session';
    const cleaned = last.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    return `claude-${cleaned}-${shortId}`;
  }
  const d = new Date(session.startTime);
  const date = d.toISOString().substring(0, 10);
  const time = d.toISOString().substring(11, 16).replace(':', '');
  return `${date}_${time}_${shortId}`;
}

function parseFormat(value: string | undefined): ExportFormat {
  if (value === undefined) return 'both';
  if (value === 'markdown' || value === 'md') return 'markdown';
  if (value === 'jsonl' || value === 'json') return 'jsonl';
  if (value === 'both') return 'both';
  throw new CliArgumentError(
    '--format must be one of: markdown, md, jsonl, json, both'
  );
}

function parseFilenameStyle(value: string | undefined): FilenameStyle {
  if (value === undefined || value === 'date') return 'date';
  if (value === 'webui') return 'webui';
  throw new CliArgumentError('--filename-style must be one of: date, webui');
}

async function resolveProjectDir(): Promise<string | null> {
  if (typeof args['project-dir'] === 'string') {
    return args['project-dir'];
  }
  if (projectArg) {
    return projectDirFromCwd(projectArg);
  }
  return projectDirFromCwd(process.cwd());
}

async function resolveOutputDirAsync(projectDir: string): Promise<string> {
  if (projectArg) {
    return join(projectArg, '.claude-sessions');
  }
  const resolved = await resolveProjectPath(projectDir);
  if (resolved) {
    return join(resolved, '.claude-sessions');
  }
  return join(process.cwd(), '.claude-sessions');
}

async function listAvailableProjects(): Promise<void> {
  const projects = await listProjects();
  if (projects.length === 0) {
    console.log('No Claude Code projects found.');
    return;
  }

  console.log(`Found ${String(projects.length)} project(s):\n`);
  for (const p of projects) {
    const resolved = await resolveProjectPath(p);
    const displayPath = resolved
      ? resolved.replace(process.env['HOME'] ?? '', '~')
      : cwdFromProjectDir(basename(p));
    const sessions = await discoverSessions(p);
    const lastExport = await readExportMarker(p);
    const exportStatus = lastExport
      ? `last export: ${new Date(lastExport).toLocaleDateString()}`
      : 'never exported';

    console.log(`  ${displayPath}`);
    console.log(`    ${String(sessions.length)} session(s), ${exportStatus}`);
    console.log('');
  }
}

function printUsage(): void {
  console.log(`
Export Claude Code sessions as clean markdown and/or JSONL.

Usage:
  claude-session-export [project-path] [options]

Arguments:
  project-path               Working directory of the project (positional)

Options:
  -p, --project <path>       Working directory of the project (same as positional)
  -P, --project-dir <path>   Claude's internal project storage path
  -o, --out <dir>            Output directory (default: <project>/.claude-sessions)
  -d, --days <n>             Only sessions from last N days
  -n, --new                  Only sessions since last export
  -l, --limit <n>            Max number of sessions
      --list-projects        List all Claude Code projects
      --dry-run              Show what would be exported
      --no-tools             Exclude tool call annotations
      --no-tool-results      Exclude tool_result blocks from JSONL output
      --no-thinking          Exclude thinking blocks
      --no-timestamps        Exclude timestamps
      --mark-exported        Update export marker (default: true)
  -f, --format <fmt>         Output format: markdown | jsonl | both (default: both)
      --filename-style <s>   Filename pattern: date | webui (default: date)
  -h, --help                 Show this help
`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(err instanceof CliArgumentError ? 2 : 1);
});

function parseNonNegativeInt(optionName: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new CliArgumentError(`${optionName} must be a non-negative integer`);
  }
  return Number(raw);
}
