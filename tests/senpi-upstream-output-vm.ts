/**
 * vm.SourceTextModule loader for byte-identical or instrumented parser copies.
 * Returns raw cross-realm values (no key stripping) for lossless equality.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vm from 'node:vm';

export type ParseResult = {
  readonly output: unknown;
  readonly diagnostics: unknown;
};

export type ParseFn = (input: unknown) => ParseResult;

/** diagnostics.d.ts: severity defaults to 'error'. */
export const DIAGNOSTICS_SHIM = `export function diagnostic(draft, source) {
  const row = {
    code: draft.code,
    severity: draft.severity ?? "error",
    message: draft.message,
    path: draft.path,
    source,
  };
  if (draft.event !== undefined) row.event = draft.event;
  return row;
}
`;

function isUnknownFunction(
  value: unknown
): value is (input: unknown) => unknown {
  return typeof value === 'function';
}

export async function loadParserVm(args: {
  readonly sourceText: string;
  readonly moduleUrl: string;
  readonly diagPath: string;
}): Promise<{ parse: ParseFn; counters: () => Record<string, unknown> }> {
  const branchCounters: Record<string, unknown> = {};
  const __hit = (id: string): number => {
    const prev = branchCounters[id];
    const next = typeof prev === 'number' ? prev + 1 : 1;
    branchCounters[id] = next;
    return next;
  };
  const __rec = (idT: string, idF: string, value: unknown): unknown => {
    if (Boolean(value)) __hit(idT);
    else __hit(idF);
    return value;
  };
  /** Switch case label: eval once, first strict === match records selection. */
  const __swCase = (
    tok: { d: unknown; s: unknown },
    caseId: string,
    expr: unknown
  ): unknown => {
    if (tok.s === undefined && tok.d === expr) tok.s = caseId;
    return expr;
  };
  /** Body selection stamp — fallthrough does not count later case selection. */
  const __swSel = (
    tok: { d: unknown; s: unknown },
    caseId: string | undefined,
    counterId: string
  ): void => {
    if (caseId === undefined) {
      if (tok.s === undefined) {
        tok.s = '';
        __hit(counterId);
      }
      return;
    }
    if (tok.s === caseId) __hit(counterId);
  };
  const context = vm.createContext({
    console,
    Error,
    TypeError,
    SyntaxError,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    undefined,
    __br: branchCounters,
    __hit,
    __rec,
    __swCase,
    __swSel,
  });
  const diagMod = new vm.SourceTextModule(DIAGNOSTICS_SHIM, {
    context,
    identifier: pathToFileURL(args.diagPath).href,
  });
  const parserMod = new vm.SourceTextModule(args.sourceText, {
    context,
    identifier: args.moduleUrl,
  });
  let diagLinked = false;
  const linker: vm.ModuleLinker = async (specifier, referrer) => {
    const id = referrer.identifier;
    if (specifier === './diagnostics.js' && id === args.moduleUrl) {
      if (!diagLinked) {
        await diagMod.link(async () => {
          throw new Error('no imports');
        });
        diagLinked = true;
      }
      return diagMod;
    }
    throw new Error(`bad import ${specifier} from ${path.basename(id)}`);
  };
  await parserMod.link(linker);
  await parserMod.evaluate();
  const exported: unknown = Reflect.get(parserMod.namespace, 'parseHookOutput');
  if (!isUnknownFunction(exported)) {
    throw new Error('parseHookOutput missing');
  }
  const parseUnknown = exported;
  return {
    parse: input => {
      const r: unknown = parseUnknown(input);
      if (typeof r !== 'object' || r === null) {
        throw new Error('bad parse result');
      }
      const output: unknown = Reflect.get(r, 'output');
      const diagnostics: unknown = Reflect.get(r, 'diagnostics');
      if (
        typeof output !== 'object' ||
        output === null ||
        Array.isArray(output)
      ) {
        throw new Error('bad output');
      }
      if (!Array.isArray(diagnostics)) throw new Error('bad diagnostics');
      for (const d of diagnostics) {
        if (typeof d !== 'object' || d === null) throw new Error('bad diag');
      }
      // Raw cross-realm values — do not strip symbols/undefined/extra keys.
      return { output, diagnostics };
    },
    counters: () => ({ ...branchCounters }),
  };
}

export function forceJsonRethrow(parse: ParseFn): void {
  const orig: typeof JSON.parse = JSON.parse;
  let force = true;
  const patched = (v: string): unknown => {
    if (force) {
      force = false;
      throw new TypeError('forced-non-syntax');
    }
    return orig(v);
  };
  const jsonObj: { parse: (v: string) => unknown } = JSON;
  jsonObj.parse = patched;
  try {
    try {
      parse({
        event: 'Stop',
        exitCode: 0,
        stdout: '{}',
        stderr: '',
        source: {
          scope: 'runtime',
          sourcePath: 'drift',
          displayOrder: 0,
          discoveredAt: 'pre-session',
        },
      });
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
  } finally {
    jsonObj.parse = orig;
  }
}
