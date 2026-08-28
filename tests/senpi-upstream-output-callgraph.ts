/**
 * Lexical call graph of vendored output-parser.js rooted at parseHookOutput.
 * Uses TypeScript compiler API on the original source bytes.
 */

import ts from 'typescript';

export type ReachableFunction = {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly calls: readonly string[];
};

type FnNode = {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly calls: Set<string>;
};

/**
 * Parse original output-parser.js and return reachable local functions
 * (declarations + const function/arrow bindings) from export parseHookOutput.
 */
export function deriveReachableParserFunctions(
  sourceText: string
): ReachableFunction[] {
  const sf = ts.createSourceFile(
    'output-parser.js',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );

  const fns = new Map<string, FnNode>();

  function collectCalls(node: ts.Node, into: Set<string>): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      into.add(node.expression.text);
    }
    ts.forEachChild(node, child => collectCalls(child, into));
  }

  function addFn(name: string, node: ts.Node, body: ts.Node | undefined): void {
    const calls = new Set<string>();
    if (body) collectCalls(body, calls);
    fns.set(name, {
      name,
      start: node.getStart(sf),
      end: node.getEnd(),
      calls,
    });
  }

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      addFn(stmt.name.text, stmt, stmt.body);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
          addFn(decl.name.text, decl, init.body);
        }
      }
    }
  }

  if (!fns.has('parseHookOutput')) {
    throw new Error('parseHookOutput declaration not found in parser source');
  }

  const reach = new Set<string>();
  const stack = ['parseHookOutput'];
  while (stack.length > 0) {
    const name = stack.pop();
    if (name === undefined || reach.has(name)) continue;
    const node = fns.get(name);
    if (!node) continue; // external/global (diagnostic, String, ...)
    reach.add(name);
    for (const callee of node.calls) stack.push(callee);
  }

  return [...reach]
    .map(name => {
      const node = fns.get(name);
      if (!node) throw new Error(`reachable missing node ${name}`);
      return {
        name: node.name,
        start: node.start,
        end: node.end,
        calls: [...node.calls].sort(),
      };
    })
    .sort((a, b) => a.start - b.start);
}
