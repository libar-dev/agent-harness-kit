/**
 * Test-only parsers for vendored senpi JavaScript runtime (trust.js, etc.).
 */

export function bracedBodyAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Marker not found: ${marker}`);
  let depth = 1;
  const bodyStart = start + marker.length;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, i);
    }
  }
  throw new Error(`Unclosed body: ${marker}`);
}

export function extractFunctionBody(source: string, name: string): string {
  const header = source.match(
    new RegExp(String.raw`function ${name}\s*\([^)]*\)[^{]*\{`)
  );
  if (header?.index === undefined) {
    throw new Error(`Function not found: ${name}`);
  }
  return bracedBodyAfter(
    source,
    source.slice(header.index, header.index + header[0].length)
  );
}

/** Last flat `return { a, b: x }` keys (shorthand + `key:`), order-independent. */
export function extractFinalReturnObjectKeys(
  source: string,
  functionName: string
): string[] {
  const body = extractFunctionBody(source, functionName);
  const last = [...body.matchAll(/return\s*\{([^{}]*)\}/g)].at(-1)?.[1];
  if (last === undefined) {
    throw new Error(`No return { ... } in ${functionName}`);
  }
  const keys: string[] = [];
  for (const part of last.split(',')) {
    const name = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    if (name) keys.push(name);
  }
  if (keys.length === 0) throw new Error(`${functionName} return has no keys`);
  return [...new Set(keys)].sort();
}

export function extractInputPropertyReads(
  source: string,
  functionName: string
): string[] {
  const keys = [
    ...extractFunctionBody(source, functionName).matchAll(
      /\binput\.([A-Za-z_][A-Za-z0-9_]*)/g
    ),
  ].map(m => m[1] ?? '');
  if (keys.length === 0) {
    throw new Error(`No input.* reads in ${functionName}`);
  }
  return [...new Set(keys)].sort();
}

export function extractScopeEqualityLiterals(source: string): string[] {
  const values = [
    ...extractFunctionBody(source, 'isHookSourceScope').matchAll(
      /===\s*['"]([^'"]+)['"]/g
    ),
  ].map(e => e[1] ?? '');
  if (values.length === 0) throw new Error('isHookSourceScope empty');
  return [...new Set(values)].sort();
}

export function extractTrustAlgorithm(source: string): {
  readonly idPrefix: string;
  readonly hashPrefix: string;
  readonly sourceKeyHashLength: number;
} {
  const idPrefix = extractFunctionBody(source, 'hookTrustId').match(
    /return `([^`$]+)\$\{/
  )?.[1];
  const hashPrefix = extractFunctionBody(source, 'hashCommandHook').match(
    /return `([^`$]+)\$\{/
  )?.[1];
  const sourceKeyHashLength = Number(
    extractFunctionBody(source, 'sourceKeyHash').match(
      /\.slice\(\s*0\s*,\s*(\d+)\s*\)/
    )?.[1]
  );
  if (!idPrefix || !hashPrefix || !Number.isFinite(sourceKeyHashLength)) {
    throw new Error('Trust algorithm pins incomplete');
  }
  return { idPrefix, hashPrefix, sourceKeyHashLength };
}

export function extractDefaultTimeoutSeconds(safetyDts: string): number {
  const m = safetyDts.match(
    /export declare const DEFAULT_HOOK_TIMEOUT_SECONDS = (\d+)/
  );
  if (!m?.[1]) throw new Error('DEFAULT_HOOK_TIMEOUT_SECONDS missing');
  return Number(m[1]);
}

export function extractSettingsLocationPaths(markdown: string): {
  readonly globalPath: string;
  readonly projectPath: string;
} {
  const globalPath = markdown.match(
    /\|\s*`([^`]+)`\s*\|\s*Global \(all projects\)/
  )?.[1];
  const projectPath = markdown.match(
    /\|\s*`([^`]+)`\s*\|\s*Project \(current directory\)/
  )?.[1];
  if (!globalPath || !projectPath) {
    throw new Error('settings.md location table missing');
  }
  return { globalPath, projectPath };
}

export function settingsMdPinSha256(pinJsonText: string): string {
  const root: unknown = JSON.parse(pinJsonText);
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('pin.json root must be an object');
  }
  const files: unknown = Reflect.get(root, 'files');
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new Error('pin.json missing files');
  }
  const entry: unknown = Reflect.get(files, 'settings.md');
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error('pin.json missing settings.md');
  }
  const sha: unknown = Reflect.get(entry, 'sha256');
  if (typeof sha !== 'string' || sha.length !== 64) {
    throw new Error('pin.json settings.md.sha256 invalid');
  }
  return sha;
}
