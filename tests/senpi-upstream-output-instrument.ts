/**
 * AST branch instrumentation for reachable parser functions.
 * 1) Downlevel optional chains via TS ES2019 transpile (no custom ?. helper).
 * 2) Count if true/false, switch *selection* (fallthrough-safe), &&/||/??, ?:.
 */

import ts from 'typescript';
import { deriveReachableParserFunctions } from './senpi-upstream-output-callgraph.js';
import {
  asExpression,
  asSourceFile,
  asStatement,
  evalHit,
  recCall,
  rewriteSwitch,
} from './senpi-upstream-output-instrument-ops.js';

export type InstrumentResult = {
  readonly source: string;
  readonly branchIds: readonly string[];
};

/** Coverage-only downlevel: native ?. → temporaries + conditionals (ES2019). */
function downlevelOptionalChains(sourceText: string): string {
  const result = ts.transpileModule(sourceText, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2019,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
    },
    fileName: 'output-parser.js',
    reportDiagnostics: false,
  });
  return result.outputText.replace(/\/\/# sourceMappingURL=.*\n?/g, '');
}

export function instrumentParserBranches(sourceText: string): InstrumentResult {
  const lowered = downlevelOptionalChains(sourceText);
  const reachable = new Set(
    deriveReachableParserFunctions(lowered).map(f => f.name)
  );
  const sf = ts.createSourceFile(
    'output-parser.js',
    lowered,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const branchIds: string[] = [];
  let seq = 0;
  const mk = (pos: number, tag: string): string => {
    const id = `${pos}:${tag}:${seq}`;
    seq += 1;
    branchIds.push(id);
    return id;
  };

  function inReachable(node: ts.Node): boolean {
    let cur: ts.Node | undefined = node;
    while (cur !== undefined) {
      if (ts.isFunctionDeclaration(cur) && cur.name) {
        return reachable.has(cur.name.text);
      }
      if (
        ts.isVariableDeclaration(cur) &&
        ts.isIdentifier(cur.name) &&
        cur.initializer !== undefined &&
        (ts.isFunctionExpression(cur.initializer) ||
          ts.isArrowFunction(cur.initializer))
      ) {
        return reachable.has(cur.name.text);
      }
      cur = cur.parent;
    }
    return false;
  }

  const transformer: ts.TransformerFactory<ts.SourceFile> = context => {
    const visit: ts.Visitor = node => {
      if (!inReachable(node)) {
        return ts.visitEachChild(node, visit, context);
      }

      if (ts.isBinaryExpression(node)) {
        const k = node.operatorToken.kind;
        if (
          k === ts.SyntaxKind.AmpersandAmpersandToken ||
          k === ts.SyntaxKind.BarBarToken ||
          k === ts.SyntaxKind.QuestionQuestionToken
        ) {
          const pos = node.getStart(sf);
          const tag =
            k === ts.SyntaxKind.AmpersandAmpersandToken
              ? 'and'
              : k === ts.SyntaxKind.BarBarToken
                ? 'or'
                : 'cq';
          const left = ts.visitNode(node.left, visit);
          const right = ts.visitNode(node.right, visit);
          if (left === undefined || right === undefined) {
            throw new Error('binary visit failed');
          }
          return ts.factory.updateBinaryExpression(
            node,
            evalHit(mk(pos, `${tag}-lhs`), asExpression(left)),
            node.operatorToken,
            evalHit(mk(pos, `${tag}-rhs`), asExpression(right))
          );
        }
      }

      if (ts.isConditionalExpression(node)) {
        const pos = node.getStart(sf);
        const c = ts.visitNode(node.condition, visit);
        const y = ts.visitNode(node.whenTrue, visit);
        const n = ts.visitNode(node.whenFalse, visit);
        if (c === undefined || y === undefined || n === undefined) {
          throw new Error('cond visit failed');
        }
        return ts.factory.updateConditionalExpression(
          node,
          recCall(mk(pos, 'cond-t'), mk(pos, 'cond-f'), asExpression(c)),
          node.questionToken,
          evalHit(mk(pos, 'cond-then'), asExpression(y)),
          node.colonToken,
          evalHit(mk(pos, 'cond-else'), asExpression(n))
        );
      }

      if (ts.isIfStatement(node)) {
        const pos = node.getStart(sf);
        const testNode = ts.visitNode(node.expression, visit);
        if (testNode === undefined) throw new Error('if test visit failed');
        const thenNode = ts.visitNode(node.thenStatement, visit);
        if (thenNode === undefined) throw new Error('if then visit failed');
        const elseRaw =
          node.elseStatement !== undefined
            ? ts.visitNode(node.elseStatement, visit)
            : undefined;
        return ts.factory.updateIfStatement(
          node,
          recCall(mk(pos, 'if-t'), mk(pos, 'if-f'), asExpression(testNode)),
          asStatement(thenNode),
          elseRaw !== undefined ? asStatement(elseRaw) : undefined
        );
      }

      if (ts.isSwitchStatement(node)) {
        return rewriteSwitch(node, sf, mk, visit);
      }

      return ts.visitEachChild(node, visit, context);
    };
    return node => {
      const out = ts.visitNode(node, visit);
      if (out === undefined) throw new Error('source transform failed');
      return asSourceFile(out);
    };
  };

  const result = ts.transform(sf, [transformer]);
  const transformed = result.transformed[0];
  if (transformed === undefined) throw new Error('no transformed source');
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  let body = printer.printFile(transformed);
  result.dispose();
  body = body.replace(/\/\/# sourceMappingURL=.*\n?/g, '');
  const mapLine = sourceText.includes('sourceMappingURL=')
    ? '//# sourceMappingURL=output-parser.js.map\n'
    : '';
  return { source: `${body}${mapLine}`, branchIds };
}

export function assertAllBranchesHit(
  counters: Readonly<Record<string, unknown>>,
  branchIds: readonly string[]
): void {
  const missing = branchIds.filter(id => {
    const value = counters[id];
    return typeof value !== 'number' || value === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `AST branch counters not hit (${missing.length}): ${missing.slice(0, 25).join(', ')}`
    );
  }
}
