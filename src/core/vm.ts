import ts from 'typescript';
import type { MigrationWarning } from './types.js';
import { camelCase } from './util.js';

export type VmFunction = ts.FunctionLikeDeclaration;

export interface VmParam {
  name: string;
  type?: string;
}

export interface VmMember {
  name: string;
  kind: 'property' | 'method' | 'getter';
  type?: string;
  initializer?: string;
  initializerNode?: ts.Expression;
  bindable: boolean;
  observable: boolean;
  fn?: VmFunction;
  line: number;
}

export interface VmImport {
  text: string;
  module: string;
  names: string[];
}

export interface VmInfo {
  className: string;
  customElementName?: string;
  members: VmMember[];
  /** Injected dependencies in constructor order. `token` is the class identifier when known. */
  injects: (VmParam & { token?: string })[];
  ctorExtraStatements: string[];
  imports: VmImport[];
  sourceFile: ts.SourceFile;
  warnings: MigrationWarning[];
  isValueConverter: boolean;
  valueConverterName?: string;
}

function decoratorsOf(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}

function decoratorName(d: ts.Decorator): string {
  const e = d.expression;
  return ts.isCallExpression(e) ? e.expression.getText() : e.getText();
}

function decoratorArgs(d: ts.Decorator): ts.Expression[] {
  return ts.isCallExpression(d.expression) ? [...d.expression.arguments] : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) ? !!ts.getModifiers(node)?.some((m) => m.kind === kind) : false;
}

export function parseSource(code: string, language: 'ts' | 'js'): ts.SourceFile {
  return ts.createSourceFile(
    language === 'ts' ? 'vm.ts' : 'vm.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    language === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
}

export function analyzeViewModel(code: string, language: 'ts' | 'js' = 'ts'): VmInfo | null {
  const sf = parseSource(code, language);
  const classes = sf.statements.filter(ts.isClassDeclaration);
  const cls =
    classes.find((c) => hasModifier(c, ts.SyntaxKind.ExportKeyword)) ?? classes[0];
  if (!cls) return null;

  const warnings: MigrationWarning[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const className = cls.name?.text ?? 'Component';

  const imports: VmImport[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const names: string[] = [];
    const clause = st.importClause;
    if (clause?.name) names.push(clause.name.text);
    if (clause?.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) names.push(...clause.namedBindings.elements.map((e) => e.name.text));
      else names.push(clause.namedBindings.name.text);
    }
    imports.push({ text: st.getText(sf), module: st.moduleSpecifier.text, names });
  }

  let customElementName: string | undefined;
  let valueConverterName: string | undefined;
  let injectTokens: string[] = [];
  let autoinject = false;
  for (const d of decoratorsOf(cls)) {
    const n = decoratorName(d);
    const args = decoratorArgs(d);
    if (n === 'inject') injectTokens = args.map((a) => a.getText());
    else if (n === 'autoinject') autoinject = true;
    else if (n === 'customElement' && args[0] && ts.isStringLiteralLike(args[0])) customElementName = args[0].text;
    else if (n === 'valueConverter' && args[0] && ts.isStringLiteralLike(args[0])) valueConverterName = args[0].text;
  }

  const members: VmMember[] = [];
  const injects: VmInfo['injects'] = [];
  const ctorExtraStatements: string[] = [];

  for (const m of cls.members) {
    if (ts.isConstructorDeclaration(m)) {
      const paramNames = new Set<string>();
      m.parameters.forEach((p, i) => {
        const name = p.name.getText(sf);
        paramNames.add(name);
        const type = p.type?.getText(sf);
        injects.push({ name, type, token: injectTokens[i] ?? type });
      });
      for (const st of m.body?.statements ?? []) {
        // Skip `this.svc = svc` DI plumbing
        if (
          ts.isExpressionStatement(st) &&
          ts.isBinaryExpression(st.expression) &&
          st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(st.expression.left) &&
          st.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(st.expression.right) &&
          paramNames.has(st.expression.right.text)
        ) {
          continue;
        }
        if (ts.isExpressionStatement(st) && st.expression.kind === ts.SyntaxKind.CallExpression && st.expression.getText(sf).startsWith('super(')) continue;
        ctorExtraStatements.push(st.getText(sf));
      }
      continue;
    }

    const name = m.name?.getText(sf);
    if (!name) continue;
    const decs = decoratorsOf(m).map(decoratorName);
    const isStatic = hasModifier(m, ts.SyntaxKind.StaticKeyword);

    if (ts.isPropertyDeclaration(m)) {
      if (isStatic) {
        if (name === 'inject' && m.initializer && ts.isArrayLiteralExpression(m.initializer)) {
          injectTokens = m.initializer.elements.map((e) => e.getText(sf));
        } else {
          warnings.push({ severity: 'info', message: `Static member "${name}" was not migrated.`, line: lineOf(m) });
        }
        continue;
      }
      const init = m.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        members.push({ name, kind: 'method', bindable: false, observable: false, fn: init, line: lineOf(m) });
      } else {
        members.push({
          name,
          kind: 'property',
          type: m.type?.getText(sf),
          initializer: init?.getText(sf),
          initializerNode: init,
          bindable: decs.includes('bindable'),
          observable: decs.includes('observable'),
          line: lineOf(m),
        });
      }
    } else if (ts.isMethodDeclaration(m)) {
      if (isStatic) {
        warnings.push({ severity: 'info', message: `Static method "${name}" was not migrated.`, line: lineOf(m) });
        continue;
      }
      members.push({ name, kind: 'method', bindable: false, observable: false, fn: m, line: lineOf(m) });
    } else if (ts.isGetAccessorDeclaration(m)) {
      members.push({ name, kind: 'getter', type: m.type?.getText(sf), bindable: false, observable: false, fn: m, line: lineOf(m) });
    } else if (ts.isSetAccessorDeclaration(m)) {
      warnings.push({ severity: 'warning', message: `Setter "${name}" has no React equivalent and was not migrated.`, line: lineOf(m), needsAi: true });
    }
  }

  // `static inject = [...]` / @inject(...) with no explicit constructor params: nothing to bind to.
  if (injects.length === 0 && (injectTokens.length || autoinject)) {
    warnings.push({ severity: 'warning', message: 'Dependency injection was declared but no constructor parameters were found.', needsAi: true });
  }
  if (autoinject && injects.length === 0) {
    /* handled above */
  }

  const isValueConverter =
    className.endsWith('ValueConverter') || members.some((m) => m.name === 'toView') || !!valueConverterName;
  if (isValueConverter && !valueConverterName) {
    valueConverterName = camelCase(className.replace(/ValueConverter$/, ''));
  }

  return {
    className,
    customElementName,
    members,
    injects,
    ctorExtraStatements,
    imports,
    sourceFile: sf,
    warnings,
    isValueConverter,
    valueConverterName,
  };
}
