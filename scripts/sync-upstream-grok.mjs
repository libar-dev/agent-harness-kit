import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const vendorDir = resolve(repoRoot, 'docs', 'upstream', 'grok');
const defaultHead = 'e5fd4816d43260c15ba785f103990c1ed6cea230';
const defaultSourceRev = 'ea094a8c369475f97c85540d01730baec0dce5d6';
const repoUrl = 'https://github.com/xai-org/grok-build';
const rawBaseUrl = 'https://raw.githubusercontent.com/xai-org/grok-build';
const pinnedAt = '2026-08-13';
const grokVersion = '1.0.3';

const sourceFiles = [
  {
    localName: 'event.rs',
    upstreamPath: 'crates/codegen/xai-grok-hooks/src/event.rs',
  },
  {
    localName: 'result.rs',
    upstreamPath: 'crates/codegen/xai-grok-hooks/src/result.rs',
  },
  {
    localName: 'runner-mod.rs',
    upstreamPath: 'crates/codegen/xai-grok-hooks/src/runner/mod.rs',
  },
  {
    localName: 'session-events-types.rs',
    upstreamPath: 'crates/codegen/xai-grok-session-events/src/types.rs',
  },
  {
    localName: 'plugins-types-lib.rs',
    upstreamPath: 'crates/codegen/xai-hooks-plugins-types/src/lib.rs',
  },
  {
    localName: 'session-update-enum.txt',
    upstreamPath: 'crates/codegen/xai-grok-shell/src/extensions/notification.rs',
    extractSessionUpdate: true,
  },
];

const notes = [
  'Hook-envelope fixtures are hand-authored field-by-field from vendored event.rs (the wire authority), since upstream serializes structs in code with no JSON literals.',
  'Optional maintainer capture procedure: install a tee-all command hook under ~/.grok/hooks/, run any grok session, redact, and commit captures; not required for tests/CI.',
  'The blake3 implementation decision for session discovery (@noble/hashes) is recorded separately during execution.',
  'Session discovery (src/grok/processing/discovery.ts) uses @noble/hashes for BLAKE3 (audited, ESM, zero runtime dependencies) so >255-byte CWD directory names exactly match upstream encode_cwd_dirname; SHA-256 is not compatible.',
];

function printUsage() {
  console.log(`Sync vendored Grok Build contract files.\n\nUsage:\n  node scripts/sync-upstream-grok.mjs <checkout-path> [--check]\n  node scripts/sync-upstream-grok.mjs <checkout-path> --from-github [--check]\n  node scripts/sync-upstream-grok.mjs --from-github [--check]\n\nOptions:\n  --check         Verify the vendor and pin manifest without writing files.\n  --from-github  Explicitly fetch raw files pinned to the checkout/manifest HEAD.\n  --help         Show this help.\n`);
}

function parseArgs(args) {
  const positional = [];
  let check = false;
  let fromGithub = false;

  for (const arg of args) {
    if (arg === '--check') {
      check = true;
    } else if (arg === '--from-github') {
      fromGithub = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      return null;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error('Expected at most one local checkout path');
  }

  if (positional.length === 0 && !fromGithub) {
    throw new Error('A local Grok Build checkout path is required unless --from-github is used');
  }

  return {
    checkoutPath: positional[0] ? resolve(positional[0]) : null,
    check,
    fromGithub,
  };
}

function readPinnedManifest() {
  const pinPath = resolve(vendorDir, 'pin.json');
  if (!existsSync(pinPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(pinPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${pinPath}: ${detail}`);
  }
}

function checkoutHead(checkoutPath) {
  if (!checkoutPath || !existsSync(checkoutPath)) {
    throw new Error(`Grok upstream checkout does not exist: ${checkoutPath}`);
  }

  try {
    return execFileSync('git', ['-C', checkoutPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Grok upstream checkout HEAD at ${checkoutPath}: ${detail}`);
  }
}

function checkoutSourceRev(checkoutPath, fallback) {
  const sourceRevPath = resolve(checkoutPath, 'SOURCE_REV');
  if (!existsSync(sourceRevPath)) {
    return fallback;
  }

  const sourceRev = readFileSync(sourceRevPath, 'utf8').trim();
  return sourceRev || fallback;
}

function sourceLineStart(text, index) {
  const newline = text.lastIndexOf('\n', index - 1);
  return newline < 0 ? 0 : newline + 1;
}

function extractionStart(text, declarationStart) {
  let start = declarationStart;
  let cursor = declarationStart;

  while (cursor > 0) {
    const previousLineEnd = cursor - 1;
    const previousLineStart = sourceLineStart(text, previousLineEnd);
    const previousLine = text.slice(previousLineStart, previousLineEnd).replace(/\r$/, '');
    if (!/^\s*#\[[^\n]*\]\s*$/.test(previousLine)) {
      break;
    }
    start = previousLineStart;
    cursor = previousLineStart;
  }

  return start;
}

function extractSessionUpdate(text, sourcePath) {
  const declaration = /^pub enum SessionUpdate\s*\{/m.exec(text);
  if (!declaration || declaration.index === undefined) {
    throw new Error(`Could not extract SessionUpdate enum from ${sourcePath}: declaration not found`);
  }

  const openBrace = text.indexOf('{', declaration.index);
  let depth = 0;
  let state = 'code';
  let blockCommentDepth = 0;
  let rawStringHashes = null;
  let closeBrace = -1;

  for (let index = openBrace; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (state === 'line-comment') {
      if (character === '\n') {
        state = 'code';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
        if (blockCommentDepth === 0) {
          state = 'code';
        }
      }
      continue;
    }

    if (state === 'string') {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        state = 'code';
      }
      continue;
    }

    if (state === 'raw-string') {
      if (character === '"') {
        const closing = '"' + '#'.repeat(rawStringHashes ?? 0);
        if (text.startsWith(closing, index)) {
          index += closing.length - 1;
          state = 'code';
        }
      }
      continue;
    }

    if (character === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (character === '"') {
      state = 'string';
      continue;
    }
    if (character === 'r') {
      const rawMatch = /^r(#+)?"/.exec(text.slice(index));
      if (rawMatch) {
        rawStringHashes = rawMatch[1]?.length ?? 0;
        index += rawMatch[0].length - 1;
        state = 'raw-string';
        continue;
      }
    }

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        closeBrace = index;
        break;
      }
      if (depth < 0) {
        break;
      }
    }
  }

  if (closeBrace < 0 || depth !== 0) {
    throw new Error(`Could not extract SessionUpdate enum from ${sourcePath}: unbalanced braces or truncated enum`);
  }

  if (sourceLineStart(text, closeBrace) !== closeBrace) {
    throw new Error(`Could not extract SessionUpdate enum from ${sourcePath}: closing brace is not at column 0`);
  }

  const end = closeBrace + 1;
  const newlineEnd = text.startsWith('\r\n', end) ? end + 2 : text[end] === '\n' ? end + 1 : end;
  return text.slice(extractionStart(text, declaration.index), newlineEnd);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesEqual(left, right) {
  return left !== null && right !== null && left.length === right.length && left.equals(right);
}

function readExisting(localName) {
  const path = resolve(vendorDir, localName);
  return existsSync(path) ? readFileSync(path) : null;
}

async function readRemote(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch ${url}: ${detail}`);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function loadSources({ checkoutPath, fromGithub, head }) {
  const expected = new Map();

  for (const source of sourceFiles) {
    const sourcePath = checkoutPath ? resolve(checkoutPath, source.upstreamPath) : null;
    const bytes = fromGithub
      ? await readRemote(`${rawBaseUrl}/${head}/${source.upstreamPath}`)
      : (() => {
          if (!sourcePath || !existsSync(sourcePath)) {
            throw new Error(`Missing upstream source file: ${sourcePath}`);
          }
          return readFileSync(sourcePath);
        })();

    expected.set(
      source.localName,
      source.extractSessionUpdate
        ? Buffer.from(extractSessionUpdate(bytes.toString('utf8'), sourcePath ?? `${rawBaseUrl}/${head}/${source.upstreamPath}`), 'utf8')
        : bytes
    );
  }

  return expected;
}

function createPin({ head, sourceRev, expected }) {
  const files = {};
  for (const source of sourceFiles) {
    files[source.localName] = {
      upstreamPath: source.upstreamPath,
      sha256: sha256(expected.get(source.localName)),
    };
  }

  return {
    repo: repoUrl,
    head,
    sourceRev,
    grokVersion,
    pinnedAt,
    files,
    fixtureRedump: 'copy small redacted updates.jsonl/events.jsonl from ~/.grok/sessions/<encoded-cwd>/<id>/ into tests/fixtures/grok/',
    notes,
  };
}

function pinBytes(pin) {
  return Buffer.from(`${JSON.stringify(pin, null, 2)}\n`, 'utf8');
}

function printSummary(entries, mode) {
  console.log(`${mode} summary:`);
  for (const entry of entries) {
    console.log(`  ${entry.status.padEnd(9)} ${entry.path}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }

  const existingPin = readPinnedManifest();
  const head = options.checkoutPath
    ? checkoutHead(options.checkoutPath)
    : existingPin?.head ?? defaultHead;
  const sourceRev = options.checkoutPath
    ? checkoutSourceRev(options.checkoutPath, existingPin?.sourceRev ?? defaultSourceRev)
    : existingPin?.sourceRev ?? defaultSourceRev;
  const expected = await loadSources({
    checkoutPath: options.checkoutPath,
    fromGithub: options.fromGithub,
    head,
  });
  const expectedPinBytes = pinBytes(createPin({ head, sourceRev, expected }));

  const entries = [];
  for (const source of sourceFiles) {
    const actual = readExisting(source.localName);
    const desired = expected.get(source.localName);
    entries.push({
      path: `docs/upstream/grok/${source.localName}`,
      status: bytesEqual(actual, desired) ? 'unchanged' : options.check ? 'drifted' : actual ? 'updated' : 'added',
    });
  }
  const actualPin = readExisting('pin.json');
  entries.push({
    path: 'docs/upstream/grok/pin.json',
    status: bytesEqual(actualPin, expectedPinBytes) ? 'unchanged' : options.check ? 'drifted' : actualPin ? 'updated' : 'added',
  });

  const drifted = entries.filter(entry => entry.status === 'drifted');
  if (options.check) {
    printSummary(entries, 'Check');
    if (drifted.length > 0) {
      throw new Error(`Vendor drift detected: ${drifted.map(entry => entry.path).join(', ')}`);
    }
    console.log('Grok upstream vendor is in sync.');
    return;
  }

  mkdirSync(vendorDir, { recursive: true });
  for (const source of sourceFiles) {
    writeFileSync(resolve(vendorDir, source.localName), expected.get(source.localName));
  }
  writeFileSync(resolve(vendorDir, 'pin.json'), expectedPinBytes);
  printSummary(entries, 'Sync');
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`sync-upstream-grok: ${message}`);
  process.exitCode = 1;
}
