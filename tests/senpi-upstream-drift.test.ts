import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOOK_INPUT_BRANCHES,
  type SenpiHookWireField,
} from '../src/senpi/hook-contract.js';
import {
  SENPI_HOOK_EVENT_NAMES,
  SENPI_UNSUPPORTED_HANDLER_TYPES,
  SENPI_UNSUPPORTED_HOOK_EVENT_NAMES,
} from '../src/senpi/settings.js';
import { SENPI_ENTRY_TAGS } from '../src/senpi/types.js';

/**
 * Upstream drift pins for the senpi adapter.
 *
 * Every extraction reads ONLY the vendored artifacts under
 * docs/upstream/senpi/ - never the npm package or any node_modules copy -
 * and compares BOTH directions against our code: vendored -> ours and
 * ours -> vendored, element-for-element.
 */

const VENDORED_ROOT = path.join(process.cwd(), 'docs/upstream/senpi');
const VENDORED_TYPES_DTS = path.join(VENDORED_ROOT, 'hooks/types.d.ts');
const VENDORED_SESSION_FORMAT = path.join(VENDORED_ROOT, 'session-format.md');
const EXPECTED_VENDORED_DTS_COUNT = 21;

function readVendoredTypes(): string {
  return readFileSync(VENDORED_TYPES_DTS, 'utf8');
}

/** Pulls the quoted elements out of one `export declare const X: readonly [...]`. */
function extractVendoredStringArray(
  source: string,
  constName: string
): string[] {
  const match = source.match(
    new RegExp(`export declare const ${constName}: readonly \\[([^\\]]*)\\]`)
  );
  if (!match?.[1]) {
    throw new Error(`Could not locate vendored constant ${constName}`);
  }
  const elements = [...match[1].matchAll(/"([^"]+)"/g)].map(
    element => element[1] ?? ''
  );
  if (elements.length === 0) {
    throw new Error(`Vendored constant ${constName} extracted as empty`);
  }
  return elements;
}

interface ExtractedBranch {
  event: string;
  fields: SenpiHookWireField[];
}

/**
 * Mechanically re-extracts every branch of the vendored HookInputWire union:
 * a textual parse of the TS member blocks, splitting members on `} | {` and
 * each property on its `readonly name? : annotation;` line.
 */
function extractHookInputWireBranches(source: string): ExtractedBranch[] {
  const startMarker = 'export type HookInputWire = {';
  const endMarker = 'export type HookOutputWire';
  const start = source.indexOf(startMarker);
  const bodyStart = start < 0 ? -1 : start + startMarker.length;
  const end = bodyStart < 0 ? -1 : source.indexOf(endMarker, bodyStart);
  if (start < 0 || bodyStart < 0 || end < 0) {
    throw new Error('Could not locate the vendored HookInputWire union');
  }

  const branches: ExtractedBranch[] = [];
  for (const member of source.slice(bodyStart, end).split('} | {')) {
    const event = member.match(/readonly event: "([A-Za-z]+)"/)?.[1];
    if (!event) {
      throw new Error('HookInputWire member without a literal event field');
    }
    const fields: SenpiHookWireField[] = [];
    for (const match of member.matchAll(
      /readonly ([A-Za-z_][A-Za-z0-9_]*)(\?)?: ([^;]+);/g
    )) {
      const name = match[1];
      const optional = match[2] === '?';
      const type = match[3]?.trim() ?? '';
      if (!name || !type) {
        throw new Error(`Malformed HookInputWire property in ${event}`);
      }
      // The discriminator IS the branch key; it is not a manifest field.
      if (name !== 'event') {
        fields.push({ name, required: !optional, type });
      }
    }
    branches.push({ event, fields });
  }
  return branches;
}

function describeField(field: SenpiHookWireField | undefined): string {
  if (!field) {
    return '<absent>';
  }
  return `${field.name}${field.required ? '' : '?'}: ${field.type}`;
}

/**
 * Two-way structural comparison with named diffs: throws an Error naming the
 * event and the exact first diverging field on either side.
 */
function assertManifestMatchesVendored(branches: ExtractedBranch[]): void {
  const vendoredByEvent = new Map(
    branches.map(branch => [branch.event, branch])
  );
  const manifestEvents = Object.keys(HOOK_INPUT_BRANCHES).sort();
  const vendoredEvents = [...vendoredByEvent.keys()].sort();

  expect(vendoredEvents).toEqual(manifestEvents);

  for (const [event, manifestFields] of Object.entries(HOOK_INPUT_BRANCHES)) {
    const vendoredFields = vendoredByEvent.get(event)?.fields ?? [];
    const length = Math.max(vendoredFields.length, manifestFields.length);
    for (let index = 0; index < length; index += 1) {
      const vendored = vendoredFields[index];
      const manifest = manifestFields[index];
      const sameShape =
        vendored !== undefined &&
        vendored.name === manifest?.name &&
        vendored.required === manifest.required &&
        vendored.type === manifest.type;
      if (!sameShape) {
        throw new Error(
          `HookInputWire drift on ${event} at field #${index}: ` +
            `vendored has ${describeField(vendored)}, ` +
            `manifest has ${describeField(manifest)}`
        );
      }
    }
  }
}

/** Top-level entry `type` literals from ```json fences, regex-based only. */
function extractSessionEntryTags(markdown: string): Set<string> {
  const tags = new Set<string>();
  for (const fence of markdown.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)) {
    for (const line of (fence[1] ?? '').split('\n')) {
      // Anchored at line-start so nested content-block types ("text") are
      // never picked up; every persisted entry opens its JSONL line.
      const tag = line.match(/^\{"type":"([a-z_]+)"/)?.[1];
      if (tag) {
        tags.add(tag);
      }
    }
  }
  if (tags.size === 0) {
    throw new Error('No json-fence entry tags found in session-format.md');
  }
  return tags;
}

describe('senpi hook event inventory upstream drift', () => {
  it('matches SUPPORTED_HOOK_EVENTS against our supported names', () => {
    const vendored = extractVendoredStringArray(
      readVendoredTypes(),
      'SUPPORTED_HOOK_EVENTS'
    );
    expect([...SENPI_HOOK_EVENT_NAMES]).toEqual(vendored);
    expect(vendored).toEqual([...SENPI_HOOK_EVENT_NAMES]);
  });

  it('matches UNSUPPORTED_KNOWN_HOOK_EVENTS against our unsupported names', () => {
    const vendored = extractVendoredStringArray(
      readVendoredTypes(),
      'UNSUPPORTED_KNOWN_HOOK_EVENTS'
    );
    expect([...SENPI_UNSUPPORTED_HOOK_EVENT_NAMES]).toEqual(vendored);
    expect(vendored).toEqual([...SENPI_UNSUPPORTED_HOOK_EVENT_NAMES]);
  });

  it('matches UNSUPPORTED_HANDLER_TYPES against our handler types', () => {
    const vendored = extractVendoredStringArray(
      readVendoredTypes(),
      'UNSUPPORTED_HANDLER_TYPES'
    );
    expect([...SENPI_UNSUPPORTED_HANDLER_TYPES]).toEqual(vendored);
    expect(vendored).toEqual([...SENPI_UNSUPPORTED_HANDLER_TYPES]);
  });

  it('pins the vendored hooks directory at exactly 21 .d.ts files', () => {
    const dtsFiles = readdirSync(path.join(VENDORED_ROOT, 'hooks')).filter(
      file => file.endsWith('.d.ts')
    );
    expect(dtsFiles).toHaveLength(EXPECTED_VENDORED_DTS_COUNT);
  });
});

describe('senpi hook input wire manifest upstream drift', () => {
  it('matches HOOK_INPUT_BRANCHES against a mechanical re-extraction', () => {
    const branches = extractHookInputWireBranches(readVendoredTypes());
    expect(branches).toHaveLength(SENPI_HOOK_EVENT_NAMES.length);
    expect(() => assertManifestMatchesVendored(branches)).not.toThrow();
  });

  it('keeps the SessionStart camelCase sessionId asymmetry', () => {
    const sessionStart = extractHookInputWireBranches(readVendoredTypes()).find(
      branch => branch.event === 'SessionStart'
    );
    expect(
      sessionStart?.fields.find(f => f.name === 'sessionId')?.required
    ).toBe(true);
    expect(
      sessionStart?.fields.find(f => f.name === 'session_id')?.required
    ).toBe(false);
  });

  it('keeps permission_mode exclusive to UserPromptSubmit', () => {
    const branches = extractHookInputWireBranches(readVendoredTypes());
    const carriers = branches
      .filter(branch => branch.fields.some(f => f.name === 'permission_mode'))
      .map(branch => branch.event);
    expect(carriers).toEqual(['UserPromptSubmit']);
  });

  it('keeps PreCompact free of accepted and PostToolUse free of transcript_path', () => {
    const branches = extractHookInputWireBranches(readVendoredTypes());
    const preCompact = branches.find(b => b.event === 'PreCompact');
    const postCompact = branches.find(b => b.event === 'PostCompact');
    const postToolUse = branches.find(b => b.event === 'PostToolUse');
    expect(preCompact?.fields.some(f => f.name === 'accepted')).toBe(false);
    expect(postCompact?.fields.some(f => f.name === 'accepted')).toBe(true);
    expect(postToolUse?.fields.some(f => f.name === 'transcript_path')).toBe(
      false
    );
  });

  it('reports a named diff when a vendored field disappears (mutation)', () => {
    const source = readVendoredTypes();
    const tamperedLine = '    readonly permission_mode?: string;\n';
    const mutated = source.replace(tamperedLine, '');
    expect(mutated).not.toBe(source);

    let failureMessage: string | undefined;
    try {
      assertManifestMatchesVendored(extractHookInputWireBranches(mutated));
    } catch (error: unknown) {
      failureMessage = error instanceof Error ? error.message : undefined;
    }
    expect(failureMessage).toBeDefined();
    expect(failureMessage).toMatch(/UserPromptSubmit/);
    expect(failureMessage).toMatch(/permission_mode/);
  });
});

describe('senpi session format docs upstream drift', () => {
  it('matches json-fence entry type literals against known-entry tags', () => {
    const markdown = readFileSync(VENDORED_SESSION_FORMAT, 'utf8');
    const documentedTags = extractSessionEntryTags(markdown);
    // The header (`session`) plus the exactly 9 known non-header tags.
    const expectedTags = new Set<string>(['session', ...SENPI_ENTRY_TAGS]);

    expect([...documentedTags].sort()).toEqual([...expectedTags].sort());
    expect([...expectedTags].sort()).toEqual([...documentedTags].sort());
  });
});
