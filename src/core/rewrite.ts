import ts from 'typescript';
import type { MigrationWarning } from './types.js';
import { setterName } from './util.js';

const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']);

const ASSIGN_OPS = new Map<ts.SyntaxKind, ts.BinaryOperator | null>([
  [ts.SyntaxKind.EqualsToken, null],
  [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.PlusToken],
  [ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.MinusToken],
  [ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskToken],
  [ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.SlashToken],
  [ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.PercentToken],
  [ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.BarBarToken],
  [ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken],
  [ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.QuestionQuestionToken],
]);

export interface Root {
  name: string;
  /** Property path below the root, e.g. user.address.city => ['address','city'] */
  path: string[];
  /** True if the chain contained a computed/index access we cannot rewrite immutably. */
  hasIndex: boolean;
}

/** Resolve `this.a.b.c` (or `a.b.c` when `thisBased` is false) to its root and path. */
export function resolveRoot(expr: ts.Expression, thisBased: boolean): Root | null {
  const path: string[] = [];
  let hasIndex = false;
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      path.unshift(cur.name.text);
      cur = cur.expression;
    } else if (ts.isElementAccessExpression(cur)) {
      hasIndex = true;
      path.unshift('[]');
      cur = cur.expression;
    } else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else break;
  }
  if (thisBased) {
    if (cur.kind !== ts.SyntaxKind.ThisKeyword || path.length === 0) return null;
    const [name, ...rest] = path;
    if (name === '[]') return null;
    return { name, path: rest, hasIndex: hasIndex || rest.includes('[]') };
  }
  if (!ts.isIdentifier(cur)) return null;
  return { name: cur.text, path, hasIndex: hasIndex || path.includes('[]') };
}

function pathExpr(f: ts.NodeFactory, root: Root): ts.Expression {
  let e: ts.Expression = f.createIdentifier(root.name);
  for (const p of root.path) e = f.createPropertyAccessExpression(e, p);
  return e;
}

/** setX(value) or setX({ ...x, a: { ...x.a, b: value } }) */
export function makeSetterCall(f: ts.NodeFactory, root: Root, value: ts.Expression): ts.Expression {
  const build = (depth: number): ts.Expression => {
    const base = pathExpr(f, { ...root, path: root.path.slice(0, depth) });
    const key = root.path[depth];
    const inner = depth === root.path.length - 1 ? value : build(depth + 1);
    return f.createObjectLiteralExpression(
      [f.createSpreadAssignment(base), f.createPropertyAssignment(key, inner)],
      false,
    );
  };
  const arg = root.path.length === 0 ? value : build(0);
  return f.createCallExpression(f.createIdentifier(setterName(root.name)), undefined, [arg]);
}

export function applyAssignOp(
  f: ts.NodeFactory,
  op: ts.SyntaxKind,
  current: ts.Expression,
  rhs: ts.Expression,
): ts.Expression {
  const bin = ASSIGN_OPS.get(op);
  if (bin === undefined || bin === null) return rhs;
  return f.createBinaryExpression(current, bin, rhs);
}

export function isAssignOp(kind: ts.SyntaxKind): boolean {
  return ASSIGN_OPS.has(kind);
}

export function containsThis(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (n.kind === ts.SyntaxKind.ThisKeyword) { found = true; return; }
    if ((ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && n !== node) return;
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function containsAwait(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isAwaitExpression(n)) { found = true; return; }
    if (ts.isFunctionLike(n) && n !== node) return;
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** Names of `this.x` members that are assigned or mutated anywhere inside `node`. */
export function collectAssigned(node: ts.Node, out: Set<string>): void {
  const walk = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && isAssignOp(n.operatorToken.kind)) {
      const r = resolveRoot(n.left, true);
      if (r) out.add(r.name);
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const r = resolveRoot(n.operand, true);
      if (r) out.add(r.name);
    } else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      MUTATORS.has(n.expression.name.text)
    ) {
      const r = resolveRoot(n.expression.expression, true);
      if (r) out.add(r.name);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
}

export interface RewriteCtx {
  /** Names declared on the class (properties, methods, getters, injected services). */
  members: Set<string>;
  /** Members that become useRef objects; `this.x` -> `x.current`. */
  refs: Set<string>;
  warnings: MigrationWarning[];
  sf: ts.SourceFile;
}

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });

export function printNode(node: ts.Node, sf: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, sf);
}

/** Rewrite `this.*` usage inside a function body to hook-style code. */
export function rewriteNode<T extends ts.Node>(node: T, ctx: RewriteCtx): T {
  const { sf, warnings, members, refs } = ctx;
  const lineOf = (n: ts.Node) => {
    try { return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1; } catch { return undefined; }
  };
  const warnedUnknown = new Set<string>();

  const transformer: ts.TransformerFactory<ts.Node> = (context) => {
    const f = context.factory;

    const visit = (n: ts.Node): ts.Node => {
      if ((ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && (n as ts.Node) !== (node as ts.Node)) {
        if (containsThis(n)) {
          warnings.push({ severity: 'warning', message: '`this` inside a nested function() was left as-is; convert to an arrow function.', line: lineOf(n), needsAi: true });
        }
        return n;
      }

      // this.a.b = v  /  this.a += v
      if (ts.isBinaryExpression(n) && isAssignOp(n.operatorToken.kind)) {
        const r = resolveRoot(n.left, true);
        if (r && !refs.has(r.name)) {
          if (r.hasIndex) {
            warnings.push({ severity: 'warning', message: `Assignment through an index on state "${r.name}" mutates in place; rewrite it immutably.`, line: lineOf(n), needsAi: true });
          } else {
            const rhs = ts.visitNode(n.right, visit) as ts.Expression;
            const current = pathExpr(f, r);
            return makeSetterCall(f, r, applyAssignOp(f, n.operatorToken.kind, current, rhs));
          }
        }
      }

      // this.count++ / --this.count
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        const r = resolveRoot(n.operand, true);
        if (r && !r.hasIndex && !refs.has(r.name)) {
          const op = n.operator === ts.SyntaxKind.PlusPlusToken ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken;
          return makeSetterCall(f, r, f.createBinaryExpression(pathExpr(f, r), op, f.createNumericLiteral(1)));
        }
      }

      // this.items.push(x) and friends
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUTATORS.has(n.expression.name.text)) {
        const r = resolveRoot(n.expression.expression, true);
        if (r && !r.hasIndex && !refs.has(r.name)) {
          const method = n.expression.name.text;
          const args = n.arguments.map((a) => ts.visitNode(a, visit) as ts.Expression);
          const isStatement = ts.isExpressionStatement(n.parent);
          const cur = () => pathExpr(f, r);
          if (isStatement && method === 'push') {
            return makeSetterCall(f, r, f.createArrayLiteralExpression([f.createSpreadElement(cur()), ...args]));
          }
          if (isStatement && method === 'unshift') {
            return makeSetterCall(f, r, f.createArrayLiteralExpression([...args, f.createSpreadElement(cur())]));
          }
          const simple = (e?: ts.Expression) => !!e && (ts.isIdentifier(e) || ts.isNumericLiteral(e) || ts.isPropertyAccessExpression(e));
          if (isStatement && method === 'splice' && args.length === 2 && simple(args[0]) && simple(args[1])) {
            const idx = f.createIdentifier('_i');
            const filter = f.createArrowFunction(
              undefined, undefined,
              [f.createParameterDeclaration(undefined, undefined, '_item'), f.createParameterDeclaration(undefined, undefined, '_i')],
              undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
              f.createBinaryExpression(
                f.createBinaryExpression(idx, ts.SyntaxKind.LessThanToken, args[0]),
                ts.SyntaxKind.BarBarToken,
                f.createBinaryExpression(
                  f.createIdentifier('_i'), ts.SyntaxKind.GreaterThanEqualsToken,
                  f.createBinaryExpression(args[0], ts.SyntaxKind.PlusToken, args[1]),
                ),
              ),
            );
            return makeSetterCall(f, r, f.createCallExpression(f.createPropertyAccessExpression(cur(), 'filter'), undefined, [filter]));
          }
          warnings.push({
            severity: 'warning',
            message: `In-place \`${method}\` on state "${r.name}" does not trigger a re-render; rewrite it immutably.`,
            line: lineOf(n),
            needsAi: true,
          });
          // fall through: keep the call but strip `this.`
        }
      }

      // this.x -> x (or x.current for refs)
      if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const name = n.name.text;
        if (!members.has(name) && !warnedUnknown.has(name)) {
          warnedUnknown.add(name);
          warnings.push({ severity: 'warning', message: `\`this.${name}\` is not declared on the class; treated as a local.`, line: lineOf(n), needsAi: true });
        }
        const id = f.createIdentifier(name);
        return refs.has(name) ? f.createPropertyAccessExpression(id, 'current') : id;
      }

      if (n.kind === ts.SyntaxKind.ThisKeyword) {
        warnings.push({ severity: 'warning', message: 'Bare `this` has no meaning in a function component.', line: lineOf(n), needsAi: true });
        return n;
      }

      return ts.visitEachChild(n, visit, context);
    };

    return (root) => ts.visitNode(root, visit)!;
  };

  const result = ts.transform(node as ts.Node, [transformer]);
  const out = result.transformed[0] as T;
  result.dispose();
  return out;
}

/** Parameter list text; untyped plain identifiers get `: any` so the output compiles under strict TS. */
export function typedParams(fn: ts.SignatureDeclarationBase, sf: ts.SourceFile): string {
  return fn.parameters
    .map((p) => {
      const text = p.getText(sf);
      if (p.type || p.initializer || p.dotDotDotToken || !ts.isIdentifier(p.name)) return text;
      return `${text}${p.questionToken ? '' : ''}: any`;
    })
    .join(', ');
}
