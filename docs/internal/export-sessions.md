# Export Claude Code Sessions

Export Claude Code sessions as clean markdown and/or structured JSONL files.

`claude-session-export` writes **both** formats by default, one `.md` file and
one `.jsonl` file per session, unless you narrow it with `--format markdown` or
`--format jsonl`.

## Quick Start

```bash
# From inside the package directory:
pnpm run export-sessions

# From anywhere (using --prefix):
pnpm --prefix /path/to/agent-harness-kit run export-sessions

# Export a specific project:
pnpm --prefix /path/to/agent-harness-kit run export-sessions /path/to/project
```

## Usage

```bash
tsx src/cli/export-sessions.ts [project-path] [options]
```

The `project-path` is the working directory of the project whose sessions you want to export. If omitted, the current working directory is used.

### Examples

```bash
# Export all sessions for current project
pnpm run export-sessions

# Export a specific project (positional arg)
pnpm run export-sessions /path/to/project

# Export a specific project (flag)
pnpm run export-sessions --project /path/to/project

# Only new sessions since last export
pnpm run export-sessions --new

# Last 7 days, limit to 10 sessions
pnpm run export-sessions --days 7 --limit 10

# Custom output directory
pnpm run export-sessions --out ~/my-exports

# List all projects with session counts
pnpm run export-sessions -- --list-projects

# Dry run (show what would be exported)
pnpm run export-sessions -- --dry-run
```

### Running From Other Directories

Use `pnpm --prefix` to run without `cd`-ing into the package directory:

```bash
# List all projects
pnpm --prefix /path/to/agent-harness-kit run export-sessions -- --list-projects

# Export project sessions
pnpm --prefix /path/to/agent-harness-kit run export-sessions /path/to/project

# Export with flags
pnpm --prefix /path/to/agent-harness-kit run export-sessions /path/to/project --days 7 --new
```

**Shell alias** (add to `~/.zshrc` or `~/.bashrc`):

```bash
alias export-sessions='pnpm --prefix /path/to/agent-harness-kit run export-sessions'
```

Then use simply:

```bash
export-sessions --list-projects
export-sessions /path/to/project --days 7
export-sessions --new
```

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--project <path>` | `-p` | Working directory of the project (same as positional arg) |
| `--project-dir <path>` | `-P` | Claude's internal project storage path (advanced) |
| `--out <dir>` | `-o` | Output directory (default: `<project>/.claude-sessions`) |
| `--days <n>` | `-d` | Only sessions from last N days |
| `--new` | `-n` | Only sessions since last export |
| `--limit <n>` | `-l` | Max number of sessions to export |
| `--list-projects` | | List all Claude Code projects with session counts |
| `--dry-run` | | Show what would be exported without writing files |
| `--no-tools` | | Exclude tool call annotations from output |
| `--no-tool-results` | | Exclude `tool_result` blocks from JSONL output |
| `--no-thinking` | | Exclude thinking blocks from output |
| `--no-timestamps` | | Exclude timestamps from output |
| `--mark-exported` | | Update export marker (default: true) |
| `--format <fmt>` | `-f` | Output format: `markdown`, `jsonl`, or `both` (default: `both`) |
| `--filename-style <style>` | | Filename pattern: `date` or `webui` (default: `date`) |
| `--help` | `-h` | Show help |

## Output

### Default Output Directory

Exported files are written to `<project>/.claude-sessions/`:

```
/path/to/project/.claude-sessions/
  2026-02-16_0805_46bfeed2.md
  2026-02-16_0805_46bfeed2.jsonl
  2026-02-15_2344_7d5ca11c.md
  2026-02-15_2344_7d5ca11c.jsonl
  ...
```

Filename format: `YYYY-MM-DD_HHMM_<session-id-prefix>.<ext>`

With the default `--format both`, each session produces both files. Switch to
`--format markdown` or `--format jsonl` if you only want one output shape.

### Structured JSONL safety

JSONL export is the structured `SessionBlock` path, not the unsafe raw-record
path from `claude-session-tail`. Tool results are included by default in
structured mode, but they still follow the block extractor contract, including
redacted text content and the 200-line truncation cap on `tool_result.content`.
Use `--no-tool-results` when the downstream consumer does not need those bodies
or when the export may contain sensitive material.

`SessionBlock.session_header.projectDir` is optional in the library API and only
appears when a caller passes `projectDir` into `extractBlocks(...)`. The
shipped `claude-session-export` CLI does not currently set it, so exported
JSONL files should not rely on that field being present.

### Markdown export safety

Markdown exports stay clean by default: they include tool call summaries, but
they do not render raw `tool_result` bodies such as file contents, bash output,
or diffs.

### What's In The Exported Markdown

- **User messages** — your actual input, cleaned of tool_result noise and system tags
- **Claude messages** — full reasoning with tool call summaries inline
- **Agent responses inline** — subagents merged by timestamp into the main conversation flow with `**Agent: xxx**` headers
- **Thinking blocks** in `<details>` tags (unless `--no-thinking`)
- **Tool calls summarized only** — no raw `tool_result` payloads in markdown output
- **No duplication** — task-notification results filtered since agent content is already inline
- **System noise stripped** — `<system-reminder>`, `<local-command-stdout>`, `<command-name>` tags removed

### Incremental Export

After each export, a marker is saved. Use `--new` next time to only export sessions created since the last export:

```bash
# First time: exports everything
pnpm run export-sessions

# Next time: only new sessions
pnpm run export-sessions --new
```

## Watch Mode

There is no built-in watch command yet. A `--watch` flag that re-exports on new session activity could be added in the future. For now, use `--new` for incremental exports, or combine with a cron/launchd job for automation.

## Files

| File | Description |
|------|-------------|
| `src/cli/export-sessions.ts` | CLI entry point |
| `src/processing/discovery.ts` | Session discovery, date filtering, export markers |
| `src/processing/formatter.ts` | Markdown formatting with `toExportMarkdown()` |
| `src/processing/denoiser.ts` | Noise removal, subagent handling |
| `src/processing/parser.ts` | JSONL parsing |
| `src/processing/types.ts` | Type definitions |
| `src/processing/index.ts` | Re-exports and convenience `exportSession()` pipeline |
