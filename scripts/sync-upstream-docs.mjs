import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const upstreamDir = resolve(repoRoot, 'docs', 'upstream');

const upstreamDocs = {
  'hooks-reference.md': 'https://code.claude.com/docs/en/hooks.md',
  'hooks-guide.md': 'https://code.claude.com/docs/en/hooks-guide.md',
  'settings.md': 'https://code.claude.com/docs/en/settings.md',
  'cli-reference.md': 'https://code.claude.com/docs/en/cli-reference.md',
  'headless.md': 'https://code.claude.com/docs/en/headless.md',
};

function printUsage() {
  const files = Object.keys(upstreamDocs)
    .map(fileName => `  - ${fileName}`)
    .join('\n');

  console.log(`Sync mirrored Claude Code docs from code.claude.com markdown endpoints.\n\nUsage:\n  node scripts/sync-upstream-docs.mjs [file ...]\n\nFiles:\n${files}`);
}

function normalizeTargets(args) {
  if (args.length === 0) {
    return Object.keys(upstreamDocs);
  }

  return args.map(arg => {
    const normalized = arg.endsWith('.md') ? arg : `${arg}.md`;

    if (!(normalized in upstreamDocs)) {
      const supported = Object.keys(upstreamDocs).join(', ');
      throw new Error(
        `Unsupported upstream doc target: ${arg}. Supported targets: ${supported}`
      );
    }

    return normalized;
  });
}

async function fetchMarkdown(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1',
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('text/markdown')) {
    throw new Error(
      `Unexpected content type for ${url}: ${contentType || 'missing content-type'}`
    );
  }

  const body = await response.text();
  return body.endsWith('\n') ? body : `${body}\n`;
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--');

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const targets = normalizeTargets(args);
  mkdirSync(upstreamDir, { recursive: true });

  for (const fileName of targets) {
    const url = upstreamDocs[fileName];
    const markdown = await fetchMarkdown(url);
    const destination = resolve(upstreamDir, fileName);
    writeFileSync(destination, markdown, 'utf8');
    console.log(`Synced ${fileName} <- ${url}`);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
