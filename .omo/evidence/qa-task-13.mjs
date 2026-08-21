import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const doc = 'docs/reference/grok-adapter.md';
const src = readFileSync(doc, 'utf8');

// Extract every backticked src/grok symbol name mentioned in the doc.
const symbols = [
  ...new Set(
    [...src.matchAll(/`([A-Za-z][A-Za-z0-9]+)(\([^`]*\))?`/g)]
      .map(m => m[1])
      .filter(s => s !== 'executeHook') // Claude runner mentioned for contrast, not a src/grok symbol
      .filter(s =>
        /^(grok|Grok|execute|read|output|validate|tail|commit|watch|reduce|fold|encode|find|list|get|parse|rewind)[A-Z]/.test(
          s
        )
      )
  ),
];

let failed = false;
console.log('== symbol existence check ==');
for (const sym of symbols) {
  let found = false;
  try {
    execSync(`grep -rn "${sym}" src/grok/`, { stdio: 'pipe' });
    found = true;
  } catch {
    found = false;
  }
  console.log(`${sym}: ${found ? 'FOUND' : 'MISSING'}`);
  if (!found) failed = true;
}

console.log('== relative link resolution ==');
const files = [doc, 'README.md'];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const links = [...text.matchAll(/\]\(([^)]+)\)/g)]
    .map(m => m[1])
    .filter(l => !l.startsWith('http') && !l.startsWith('#'));
  for (const link of links) {
    const target = resolve(dirname(file), link.replace(/#.*$/, ''));
    const ok = existsSync(target);
    if (file === doc || link.includes('grok')) {
      console.log(`${file} -> ${link}: ${ok ? 'RESOLVED' : 'BROKEN'}`);
      if (!ok) failed = true;
    }
  }
}

process.exit(failed ? 1 : 0);
