import ts from 'typescript';
import { applyAssignOp, isAssignOp, makeSetterCall, resolveRoot } from './rewrite.js';
import type { MigrationWarning } from './types.js';
import { GLOBALS } from './util.js';

export interface RepeatScope {
  itemName: string;
  usesArray: boolean;
}

export interface ExprCtx {
  /** Known view-model names (members + injected services). */
  vmNames: Set<string>;
  /** Names assigned from the view; they must become state. */
  assigned: Set<string>;
  /** Names that are useRef objects. */
  refs: Set<string>;
  repeatStack: RepeatScope[];
  warnings: MigrationWarning[];
  flags: { usesValueConverters: boolean };
}

export interface ConvertedExpr {
  code: string;
  usesEvent: boolean;
}

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

interface Split {
  base: string;
  converters: { name: string; args: string[] }[];
  behaviors: string[];
}

/** Split an Aurelia expression into `base | converter:arg & behavior` parts at top level. */
export function splitConvertersAndBehaviors(expr: string): Split {
  const cuts: { idx: number; kind: '|' | '&' }[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && (c === '|' || c === '&')) {
      if (expr[i + 1] === c) { i++; continue; }
      cuts.push({ idx: i, kind: c });
    }
  }
  if (cuts.length === 0) return { base: expr.trim(), converters: [], behaviors: [] };
  const parts: { kind: '|' | '&' | null; text: string }[] = [];
  let last = 0;
  let lastKind: '|' | '&' | null = null;
  for (const c of cuts) {
    parts.push({ kind: lastKind, text: expr.slice(last, c.idx) });
    last = c.idx + 1;
    lastKind = c.kind;
  }
  parts.push({ kind: lastKind, text: expr.slice(last) });

  const converters: Split['converters'] = [];
  const behaviors: string[] = [];
  for (const p of parts.slice(1)) {
    const pieces = splitTop(p.text, ':').map((s) => s.trim());
    if (p.kind === '|') converters.push({ name: pieces[0], args: pieces.slice(1) });
    else behaviors.push(pieces.join(':'));
  }
  return { base: parts[0].text.trim(), converters, behaviors };
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === sep) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out;
}

function parseExpression(code: string): { sf: ts.SourceFile; expr: ts.Expression } | null {
  const sf = ts.createSourceFile('e.ts', `const __x = (${code});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  if (diags.length) return null;
  const st = sf.statements[0];
  if (!st || !ts.isVariableStatement(st)) return null;
  const init = st.declarationList.declarations[0]?.initializer;
  if (!init) return null;
  let e: ts.Expression = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return { sf, expr: e };
}

function collectLocals(root: ts.Node): Set<string> {
  const locals = new Set<string>();
  const walk = (n: ts.Node) => {
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      for (const p of n.parameters) if (ts.isIdentifier(p.name)) locals.add(p.name.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(root);
  return locals;
}

function isFreeReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isParameter(p) && p.name === id) return false;
  if (ts.isMethodDeclaration(p) && p.name === id) return false;
  return true;
}

export function convertExpression(raw: string, ctx: ExprCtx, mode: 'value' | 'handler' = 'value'): ConvertedExpr {
  const { base, converters, behaviors } = splitConvertersAndBehaviors(raw);
  const warn = (message: string, needsAi = true, severity: MigrationWarning['severity'] = 'warning') =>
    ctx.warnings.push({ severity, message, needsAi });

  if (behaviors.length) warn(`Binding behavior(s) "${behaviors.join(', ')}" on \`${raw}\` were dropped; re-implement in React (e.g. debounce).`);

  const parsed = parseExpression(base);
  if (!parsed) {
    warn(`Could not parse expression \`${raw}\`; copied verbatim.`);
    return { code: base, usesEvent: false };
  }
  const { sf, expr } = parsed;
  const locals = collectLocals(expr);
  const repeat = ctx.repeatStack[ctx.repeatStack.length - 1];
  const scopeVars = new Set(ctx.repeatStack.map((r) => r.itemName));
  let usesEvent = false;

  // Validation pass
  const checked = new Set<string>();
  const check = (n: ts.Node) => {
    if (ts.isIdentifier(n) && isFreeReference(n)) {
      const name = n.text;
      if (checked.has(name)) return;
      checked.add(name);
      if (name === '$parent' || name === '$this' || name === '$context') {
        warn(`\`${name}\` in \`${raw}\` has no direct React equivalent; pass the value down explicitly.`);
      } else if (
        !(GLOBALS.has(name) || locals.has(name) || scopeVars.has(name) || ctx.vmNames.has(name) ||
          name === '$event' || /^\$(index|first|last|even|odd|middle|length)$/.test(name))
      ) {
        warn(`Identifier "${name}" in \`${raw}\` is not declared on the view-model.`);
      }
    }
    ts.forEachChild(n, check);
  };
  check(expr);

  const transformer: ts.TransformerFactory<ts.Node> = (context) => {
    const f = context.factory;
    const visit = (n: ts.Node): ts.Node => {
      if (ts.isIdentifier(n) && isFreeReference(n) && !locals.has(n.text)) {
        const name = n.text;
        if (name === '$event') { usesEvent = true; return f.createIdentifier('event'); }
        if (/^\$(first|last|even|odd|middle)$/.test(name)) {
          if (!repeat) { warn(`\`${name}\` used outside repeat.for in \`${raw}\`.`); return n; }
          const idx = f.createIdentifier('$index');
          switch (name) {
            case '$first': return f.createBinaryExpression(idx, ts.SyntaxKind.EqualsEqualsEqualsToken, f.createNumericLiteral(0));
            case '$even': return f.createBinaryExpression(f.createBinaryExpression(idx, ts.SyntaxKind.PercentToken, f.createNumericLiteral(2)), ts.SyntaxKind.EqualsEqualsEqualsToken, f.createNumericLiteral(0));
            case '$odd': return f.createBinaryExpression(f.createBinaryExpression(idx, ts.SyntaxKind.PercentToken, f.createNumericLiteral(2)), ts.SyntaxKind.EqualsEqualsEqualsToken, f.createNumericLiteral(1));
            default: {
              repeat.usesArray = true;
              const lastIdx = f.createBinaryExpression(f.createPropertyAccessExpression(f.createIdentifier('$array'), 'length'), ts.SyntaxKind.MinusToken, f.createNumericLiteral(1));
              if (name === '$last') return f.createBinaryExpression(idx, ts.SyntaxKind.EqualsEqualsEqualsToken, lastIdx);
              return f.createBinaryExpression(
                f.createBinaryExpression(idx, ts.SyntaxKind.ExclamationEqualsEqualsToken, f.createNumericLiteral(0)),
                ts.SyntaxKind.AmpersandAmpersandToken,
                f.createBinaryExpression(idx, ts.SyntaxKind.ExclamationEqualsEqualsToken, lastIdx),
              );
            }
          }
        }
        if (name === '$length') { repeat && (repeat.usesArray = true); return f.createPropertyAccessExpression(f.createIdentifier('$array'), 'length'); }
        if (ctx.refs.has(name)) return f.createPropertyAccessExpression(n, 'current');
      }

      // assignments to view-model state
      if (ts.isBinaryExpression(n) && isAssignOp(n.operatorToken.kind)) {
        const r = resolveRoot(n.left, false);
        if (r && ctx.vmNames.has(r.name) && !scopeVars.has(r.name) && !locals.has(r.name)) {
          if (r.hasIndex) {
            warn(`Assignment through an index in \`${raw}\` mutates state in place; rewrite it immutably.`);
          } else {
            ctx.assigned.add(r.name);
            const rhs = ts.visitNode(n.right, visit) as ts.Expression;
            const current = ts.visitNode(n.left, visit) as ts.Expression;
            return makeSetterCall(f, r, applyAssignOp(f, n.operatorToken.kind, current, rhs));
          }
        } else if (r && scopeVars.has(r.name)) {
          warn(`Assignment to repeat item "${r.name}" in \`${raw}\` cannot update the source array; update it immutably.`);
        }
      }
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        const r = resolveRoot(n.operand, false);
        if (r && ctx.vmNames.has(r.name) && !r.hasIndex && !scopeVars.has(r.name)) {
          ctx.assigned.add(r.name);
          const op = n.operator === ts.SyntaxKind.PlusPlusToken ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken;
          return makeSetterCall(f, r, f.createBinaryExpression(ts.visitNode(n.operand, visit) as ts.Expression, op, f.createNumericLiteral(1)));
        }
      }
      return ts.visitEachChild(n, visit, context);
    };
    return (root) => ts.visitNode(root, visit)!;
  };

  const res = ts.transform(expr as ts.Node, [transformer]);
  let code = printer.printNode(ts.EmitHint.Expression, res.transformed[0], sf);
  res.dispose();

  if (converters.length) {
    ctx.flags.usesValueConverters = true;
    for (const c of converters) {
      const args = c.args.map((a) => convertExpression(a, ctx, 'value').code);
      code = `valueConverters.${c.name}(${[code, ...args].join(', ')})`;
    }
    warn(`Value converter(s) ${converters.map((c) => `"${c.name}"`).join(', ')} map to generated functions in valueConverters.ts; review them.`, false, 'info');
  }

  return { code, usesEvent };
}

/** Whether an expression is a simple assignable path like `user.name` (no calls, no indexes). */
export function simplePath(raw: string): { root: string; path: string[] } | null {
  const m = raw.trim().match(/^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)$/);
  if (!m) return null;
  return { root: m[1], path: m[2] ? m[2].slice(1).split('.') : [] };
}
