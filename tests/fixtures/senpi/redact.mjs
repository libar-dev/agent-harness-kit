#!/usr/bin/env node
/**
 * Deterministic redaction of senpi session JSONL into fixture outputs.
 *
 * Usage:
 *   node tests/fixtures/senpi/redact.mjs <source.jsonl> [source.jsonl ...] [--out <dir>]
 *
 * No machine-specific defaults: callers must supply source paths (read-only).
 * Rerunning against the same sources MUST produce byte-identical output
 * (no wall-clock stamps; stubs derived from content hashes).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = __dirname;
const HOME = homedir();
const USER = HOME.split('/').filter(Boolean).pop() || 'user';

const FIXTURE_USER = 'fixture-user';
const FIXTURE_HOME = `/Users/${FIXTURE_USER}`;
const REAL_HOME_PREFIXES = [
  HOME,
  `/Users/${USER}`,
  // encoded cwd dir segments used in session paths / parentSession
  HOME.replace(/\//g, '-'),
  `/Users/${USER}`.replace(/\//g, '-'),
];

function sha16(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
}

function sha32(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 32);
}

/** Stable UUID-shaped id from any input string. */
function mapUuid(original) {
  const h = sha32(`senpi-fixture-uuid:${original}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function scrubPaths(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  // Longest home prefixes first
  const prefixes = [...REAL_HOME_PREFIXES].sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (!p) continue;
    if (out.includes(p)) {
      const replacement = p.startsWith('-') || p.includes('--')
        ? FIXTURE_HOME.replace(/\//g, '-')
        : FIXTURE_HOME;
      out = out.split(p).join(replacement);
    }
  }
  // Bare username residual (path segments, prose)
  if (USER && USER.length >= 3) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(USER)}(?![A-Za-z0-9_])`, 'g');
    out = out.replace(re, FIXTURE_USER);
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textStub(kind, original) {
  const h = sha16(`${kind}:${original}`);
  return `[redacted:${kind}:${h}]`;
}

function scrubString(kind, s) {
  if (typeof s !== 'string') return s;
  // Always replace free text with a deterministic stub so source substrings
  // cannot leak. Path scrub runs on the original only for hash input stability
  // is NOT needed - hash original for stability across path conventions.
  return textStub(kind, s);
}

function redactDeep(value, kind = 'val') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(kind, value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((v, i) => redactDeep(v, `${kind}[${i}]`));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, `${kind}.${k}`);
    }
    return out;
  }
  return value;
}

/** Redact message body while preserving role/shape/numeric metadata. */
function redactMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const m = { ...message };

  switch (m.role) {
    case 'user':
    case 'custom':
      m.content = redactContent(m.content, 'msg');
      if ('details' in m) m.details = redactDeep(m.details, 'msg.details');
      break;
    case 'assistant': {
      if (Array.isArray(m.content)) {
        m.content = m.content.map((block) => redactContentBlock(block));
      }
      if (typeof m.errorMessage === 'string') {
        m.errorMessage = scrubString('err', m.errorMessage);
      }
      // api/provider/model/usage/stopReason/timestamp kept (not user prose)
      break;
    }
    case 'toolResult': {
      if (Array.isArray(m.content)) {
        m.content = m.content.map((block) => redactContentBlock(block));
      }
      if ('details' in m) m.details = redactDeep(m.details, 'tool.details');
      break;
    }
    case 'bashExecution': {
      if (typeof m.command === 'string') m.command = scrubString('bash.cmd', m.command);
      if (typeof m.output === 'string') m.output = scrubString('bash.out', m.output);
      if (typeof m.fullOutputPath === 'string') {
        m.fullOutputPath = scrubPaths(m.fullOutputPath);
        // still stub residual free path text identity
        m.fullOutputPath = scrubString('bash.path', m.fullOutputPath);
      }
      break;
    }
    case 'branchSummary': {
      if (typeof m.summary === 'string') m.summary = scrubString('branch.summary', m.summary);
      break;
    }
    case 'compactionSummary': {
      if (typeof m.summary === 'string') m.summary = scrubString('comp.summary', m.summary);
      break;
    }
    default: {
      // Unknown role: deep-redact string leaves, keep structure
      return redactDeep(m, 'msg.unknown');
    }
  }
  return m;
}

function redactContent(content, kind) {
  if (typeof content === 'string') return scrubString(kind, content);
  if (Array.isArray(content)) return content.map((b) => redactContentBlock(b));
  return content;
}

function redactContentBlock(block) {
  if (!block || typeof block !== 'object') return block;
  const b = { ...block };
  switch (b.type) {
    case 'text':
      if (typeof b.text === 'string') b.text = scrubString('text', b.text);
      break;
    case 'thinking':
      if (typeof b.thinking === 'string') b.thinking = scrubString('thinking', b.thinking);
      break;
    case 'image':
      if (typeof b.data === 'string') {
        b.data = textStub('image', b.data);
      }
      // mimeType kept
      break;
    case 'toolCall':
      if (b.arguments && typeof b.arguments === 'object') {
        b.arguments = redactDeep(b.arguments, 'tool.args');
      }
      // id + name kept (tool name is schema, not user prose)
      break;
    default:
      return redactDeep(b, 'block');
  }
  return b;
}

function redactEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const e = { ...entry };

  switch (e.type) {
    case 'session': {
      if (typeof e.id === 'string') e.id = mapUuid(e.id);
      if (typeof e.cwd === 'string') {
        e.cwd = scrubPaths(e.cwd);
      }
      if (typeof e.parentSession === 'string') {
        e.parentSession = scrubPaths(e.parentSession);
        // Map any embedded session filename uuid
        e.parentSession = e.parentSession.replace(
          /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
          (m) => mapUuid(m),
        );
      }
      break;
    }
    case 'message': {
      if (e.message) e.message = redactMessage(e.message);
      break;
    }
    case 'model_change':
    case 'thinking_level_change':
      // structural / model ids only
      break;
    case 'compaction': {
      if (typeof e.summary === 'string') e.summary = scrubString('compaction.summary', e.summary);
      if (Array.isArray(e.retainedTail)) {
        e.retainedTail = e.retainedTail.map((m) => redactMessage(m));
      }
      if ('details' in e) e.details = redactDeep(e.details, 'compaction.details');
      // firstKeptEntryId, tokensBefore, usage, fromHook kept
      break;
    }
    case 'branch_summary': {
      if (typeof e.summary === 'string') e.summary = scrubString('branch_summary', e.summary);
      if ('details' in e) e.details = redactDeep(e.details, 'branch.details');
      break;
    }
    case 'custom': {
      // customType kept (extension id density); data fully stubbed
      if ('data' in e) e.data = redactDeep(e.data, `custom.${e.customType ?? 'data'}`);
      break;
    }
    case 'custom_message': {
      e.content = redactContent(e.content, 'custom_message');
      if ('details' in e) e.details = redactDeep(e.details, 'custom_message.details');
      break;
    }
    case 'label': {
      if (typeof e.label === 'string') e.label = scrubString('label', e.label);
      break;
    }
    case 'session_info': {
      if (typeof e.name === 'string') e.name = scrubString('session_info.name', e.name);
      break;
    }
    default: {
      // Unknown entry types: deep-redact string leaves, keep tree ids/timestamps
      const keep = new Set(['type', 'id', 'parentId', 'timestamp']);
      for (const [k, v] of Object.entries(e)) {
        if (keep.has(k)) continue;
        e[k] = redactDeep(v, `unk.${k}`);
      }
      break;
    }
  }

  // Final pass: any residual home/username strings anywhere in the entry JSON
  return scrubTreePaths(e);
}

function scrubTreePaths(value) {
  if (typeof value === 'string') return scrubPaths(value);
  if (Array.isArray(value)) return value.map(scrubTreePaths);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubTreePaths(v);
    return out;
  }
  return value;
}

function stableStringify(obj) {
  // JSON.stringify is insertion-order stable for our shallow copies from parse.
  return JSON.stringify(obj);
}

function redactFile(sourcePath, outDir) {
  const abs = resolve(sourcePath);
  if (!existsSync(abs)) {
    throw new Error(`source not found: ${abs}`);
  }
  const raw = readFileSync(abs, 'utf8');
  // Preserve whether file ended with trailing newline
  const endedWithNl = raw.endsWith('\n');
  const lines = raw.split('\n');
  // If file ends with \n, last split element is ''; drop it for processing
  if (endedWithNl && lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }

  let sessionIdForName = null;
  const outLines = [];
  for (const line of lines) {
    if (line.trim() === '') {
      outLines.push('');
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Preserve unparseable lines as empty object marker? Drop content.
      outLines.push(stableStringify({ type: 'invalid_redacted', note: textStub('invalid', line) }));
      continue;
    }
    if (parsed?.type === 'session' && typeof parsed.id === 'string') {
      sessionIdForName = parsed.id;
    }
    const redacted = redactEntry(parsed);
    outLines.push(stableStringify(redacted));
  }

  const body = outLines.join('\n') + (endedWithNl || outLines.length ? '\n' : '');
  const short =
    sessionIdForName != null
      ? mapUuid(sessionIdForName).slice(0, 8)
      : sha16(basename(abs)).slice(0, 8);
  const outName = `real-${short}.jsonl`;
  const outPath = join(outDir, outName);
  return { outPath, outName, body, sourcePath: abs };
}

function parseArgs(argv) {
  const sources = [];
  let outDir = DEFAULT_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      const next = argv[++i];
      if (!next) throw new Error('--out requires a directory path');
      outDir = resolve(next);
      continue;
    }
    if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`);
    }
    sources.push(a);
  }
  return { sources, outDir };
}

function usage() {
  return [
    'Usage: node tests/fixtures/senpi/redact.mjs <source.jsonl> [source.jsonl ...] [--out <dir>]',
    '  Sources are required (no baked-in machine paths).',
    '  --out defaults to this script directory.',
  ].join('\n');
}

function main() {
  let sources;
  let outDir;
  try {
    ({ sources, outDir } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(String(err?.message || err));
    console.error(usage());
    process.exit(2);
  }

  if (sources.length === 0) {
    console.error('error: at least one source.jsonl path is required');
    console.error(usage());
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const src of sources) {
    const r = redactFile(src, outDir);
    writeFileSync(r.outPath, r.body, 'utf8');
    results.push(r);
    console.log(`wrote ${r.outName} (${Buffer.byteLength(r.body, 'utf8')} bytes)`);
  }

  // Machine-readable summary (no source paths / original ids — those stay local to the caller)
  console.log(
    JSON.stringify({
      ok: true,
      count: results.length,
      outDir,
      outputs: results.map((r) => ({
        outName: r.outName,
        bytes: Buffer.byteLength(r.body, 'utf8'),
      })),
    }),
  );
}

main();
