/**
 * AST rewrite helpers for reachable branch counters (if/switch/logical/?:).
 */

import ts from 'typescript';

export function asExpression(node: ts.Node): ts.Expression {
  if (!ts.isExpression(node)) throw new Error('expected Expression');
  return node;
}

export function asStatement(node: ts.Node): ts.Statement {
  if (!ts.isStatement(node)) throw new Error('expected Statement');
  return node;
}

export function asSourceFile(node: ts.Node): ts.SourceFile {
  if (!ts.isSourceFile(node)) throw new Error('expected SourceFile');
  return node;
}

export function hitCall(id: string): ts.Expression {
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier('__hit'),
    undefined,
    [ts.factory.createStringLiteral(id)]
  );
}

export function hitStmt(id: string): ts.Statement {
  return ts.factory.createExpressionStatement(hitCall(id));
}

/** Increments true/false ids from truthiness; returns original value. */
export function recCall(
  idT: string,
  idF: string,
  expr: ts.Expression
): ts.Expression {
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier('__rec'),
    undefined,
    [
      ts.factory.createStringLiteral(idT),
      ts.factory.createStringLiteral(idF),
      expr,
    ]
  );
}

/** Evaluates expr and stamps id (for short-circuit operand / arm entry). */
export function evalHit(id: string, expr: ts.Expression): ts.Expression {
  return ts.factory.createParenthesizedExpression(
    ts.factory.createBinaryExpression(
      hitCall(id),
      ts.SyntaxKind.CommaToken,
      expr
    )
  );
}

/**
 * Case-label helper: evaluate expr once, record selection on first strict
 * match against tok.d, return expr unchanged for the switch comparison.
 */
export function swCaseCall(
  tok: ts.Expression,
  caseId: string,
  expr: ts.Expression
): ts.Expression {
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier('__swCase'),
    undefined,
    [tok, ts.factory.createStringLiteral(caseId), expr]
  );
}

/**
 * Body selection stamp: hits counter only when tok.s equals caseId
 * (or when caseId is the default sentinel and nothing matched).
 */
export function swSelStmt(
  tok: ts.Expression,
  caseId: string | undefined,
  counterId: string
): ts.Statement {
  return ts.factory.createExpressionStatement(
    ts.factory.createCallExpression(
      ts.factory.createIdentifier('__swSel'),
      undefined,
      [
        tok,
        caseId === undefined
          ? ts.factory.createIdentifier('undefined')
          : ts.factory.createStringLiteral(caseId),
        ts.factory.createStringLiteral(counterId),
      ]
    )
  );
}

/** Fallthrough-safe switch: token holds discriminant + selected case id. */
export function rewriteSwitch(
  node: ts.SwitchStatement,
  sf: ts.SourceFile,
  mk: (pos: number, tag: string) => string,
  visit: ts.Visitor
): ts.Statement {
  const pos = node.getStart(sf);
  const tokId = ts.factory.createIdentifier(`__sw${pos}`);
  const disc = ts.visitNode(node.expression, visit);
  if (disc === undefined) throw new Error('switch expr visit failed');

  const tokInit = ts.factory.createObjectLiteralExpression(
    [
      ts.factory.createPropertyAssignment('d', asExpression(disc)),
      ts.factory.createPropertyAssignment('s', ts.factory.createVoidZero()),
    ],
    false
  );
  const tokDecl = ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          tokId,
          undefined,
          undefined,
          tokInit
        ),
      ],
      ts.NodeFlags.Const
    )
  );

  let hasDefault = false;
  const clauses: ts.CaseOrDefaultClause[] = [];
  for (const clause of node.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      hasDefault = true;
      const selId = mk(pos, 'sw-default');
      const stmts = [
        swSelStmt(tokId, undefined, selId),
        ...clause.statements.map(s => {
          const v = ts.visitNode(s, visit);
          if (v === undefined) throw new Error('default stmt failed');
          return asStatement(v);
        }),
      ];
      clauses.push(ts.factory.updateDefaultClause(clause, stmts));
      continue;
    }
    const caseId = mk(clause.getStart(sf), 'sw-case');
    const cExpr = ts.visitNode(clause.expression, visit);
    if (cExpr === undefined) throw new Error('case expr failed');
    const stmts = [
      swSelStmt(tokId, caseId, caseId),
      ...clause.statements.map(s => {
        const v = ts.visitNode(s, visit);
        if (v === undefined) throw new Error('case stmt failed');
        return asStatement(v);
      }),
    ];
    clauses.push(
      ts.factory.updateCaseClause(
        clause,
        swCaseCall(tokId, caseId, asExpression(cExpr)),
        stmts
      )
    );
  }
  if (!hasDefault) {
    const nomatch = mk(pos, 'sw-nomatch');
    clauses.push(
      ts.factory.createDefaultClause([swSelStmt(tokId, undefined, nomatch)])
    );
  }

  const sw = ts.factory.updateSwitchStatement(
    node,
    ts.factory.createPropertyAccessExpression(tokId, 'd'),
    ts.factory.updateCaseBlock(node.caseBlock, clauses)
  );
  return ts.factory.createBlock([tokDecl, sw], true);
}
