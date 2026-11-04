// The error codes (`OtterError.details`) the packages raise, read from their sources (TSDoc
// convention 4, AGENT §4: the table in OtterError's comment lists every code, checked both ways by
// `pnpm check:docs-site`). A code is a string in the `details` of an object literal (createError's
// init, or an error record), or a string argument of a local helper that passes one of its
// parameters on as `details`. A template literal gives a prefix (`shaka${code}` → `shaka*`).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'ts5';

/** Code → the files it appears in (repository-relative). */
export type ErrorCodes = ReadonlyMap<string, readonly string[]>;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'vendor' || d.name === 'test' ? [] : sourceFiles(p);
    return /\.ts$/.test(d.name) && !/\.(test|d)\.ts$/.test(d.name) ? [p] : [];
  });

/** The codes an expression can evaluate to: string literals (through `??`, `||`, `? :`), template prefixes. */
function codesOf(e: ts.Expression): string[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) return [`${e.head.text}*`];
  if (ts.isParenthesizedExpression(e)) return codesOf(e.expression);
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return [...codesOf(e.left), ...codesOf(e.right)];
  if (ts.isConditionalExpression(e)) return [...codesOf(e.whenTrue), ...codesOf(e.whenFalse)];
  return [];
}

/** Codes in one source text. */
export function errorCodesIn(text: string, fileName = 'x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  /** Helper name → index of the parameter it passes on as `details`. */
  const helpers = new Map<string, number>();
  const enclosingFunction = (n: ts.Node): ts.SignatureDeclaration | undefined => {
    for (let p = n.parent; p !== undefined; p = p.parent) if (ts.isFunctionLike(p)) return p;
    return undefined;
  };
  const helperName = (f: ts.SignatureDeclaration): string | undefined => {
    if (f.name !== undefined && ts.isIdentifier(f.name)) return f.name.text;
    const p = f.parent;
    return p !== undefined && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text : undefined;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'details' && ts.isObjectLiteralExpression(n.parent)) {
      out.push(...codesOf(n.initializer));
      if (ts.isIdentifier(n.initializer)) {
        const f = enclosingFunction(n);
        const at = f?.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === (n.initializer as ts.Identifier).text) ?? -1;
        const name = f === undefined ? undefined : helperName(f);
        if (at >= 0 && name !== undefined) helpers.set(name, at);
      }
    }
    // Shorthand `{ type, details, ... }` in a helper.
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === 'details' && ts.isObjectLiteralExpression(n.parent)) {
      const f = enclosingFunction(n);
      const at = f?.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === 'details') ?? -1;
      const name = f === undefined ? undefined : helperName(f);
      if (at >= 0 && name !== undefined) helpers.set(name, at);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const calls = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : undefined;
      const at = callee === undefined ? undefined : helpers.get(callee);
      const arg = at === undefined ? undefined : n.arguments[at];
      if (arg !== undefined) out.push(...codesOf(arg));
    }
    ts.forEachChild(n, calls);
  };
  calls(sf);
  return out;
}

/** Every code raised by `packages/*\/src` (tests, declarations and vendored code excluded). */
export function readErrorCodes(root: string): ErrorCodes {
  const codes = new Map<string, string[]>();
  const packages = join(root, 'packages');
  for (const dir of readdirSync(packages).sort()) {
    let files: string[];
    try {
      files = sourceFiles(join(packages, dir, 'src'));
    } catch {
      continue;
    }
    for (const file of files) {
      for (const code of errorCodesIn(readFileSync(file, 'utf8'), file)) {
        const rel = relative(root, file);
        const list = codes.get(code) ?? [];
        if (!list.includes(rel)) list.push(rel);
        codes.set(code, list);
      }
    }
  }
  return codes;
}
