// Mechanical strict-mode pass for L2 copies (ADR-007 §1, REUSE §5: vendored code passes strict TS).
// Upstream code indexes arrays and typed arrays without bounds proofs; under
// noUncheckedIndexedAccess those reads are `T | undefined`. This tool asserts them non-null where
// the compiler complains, which keeps upstream behaviour exactly (a missing element was a runtime
// bug there too). Everything else is left for a human.
//
//   node scripts/vendor-strictify.ts vendor/hls.js/tsconfig.json [--write]
//
// Without --write it only reports what it would change.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// TypeScript 7 (the native port) has no compiler API yet; ts5 is a dev-only alias of typescript@5.9.
import ts from 'ts5';

const [configPath, flag] = process.argv.slice(2);
if (configPath === undefined) throw new Error('usage: vendor-strictify.ts <tsconfig.json> [--write]');
const write = flag === '--write';

/** "possibly undefined" family. */
const CODES = new Set([2532, 18048, 2345, 2322, 2769, 2538, 18047]);

function program(): ts.Program {
  const file = resolve(configPath as string);
  const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (parsed === undefined) throw new Error(`cannot read ${file}`);
  return ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true }, projectReferences: parsed.projectReferences ?? [] });
}

const isIndexRead = (n: ts.Node): n is ts.ElementAccessExpression =>
  ts.isElementAccessExpression(n) && !(ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);

function innermost(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      found = n;
      n.forEachChild(visit);
    }
  };
  visit(sf);
  return found;
}

/** The element access to assert for a diagnostic at `pos`, if this tool can fix it. */
function target(sf: ts.SourceFile, checker: ts.TypeChecker, pos: number, length: number): ts.ElementAccessExpression | undefined {
  let n = innermost(sf, pos);
  // Widen to the expression the diagnostic spans.
  while (n !== undefined && n.parent !== undefined && n.getStart(sf) === pos && n.parent.getStart(sf) === pos && n.parent.getEnd() <= pos + length) n = n.parent;
  for (let cur = n; cur !== undefined && cur.getEnd() <= pos + length + 1; cur = cur.parent) {
    if (isIndexRead(cur)) return cur;
    if (cur.parent === undefined || cur.parent.getStart(sf) !== cur.getStart(sf)) break;
  }
  // `x` possibly undefined: assert where x was initialised from an index read.
  if (n !== undefined && ts.isIdentifier(n)) {
    const symbol = ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
    const decl = symbol?.valueDeclaration;
    if (decl !== undefined && ts.isVariableDeclaration(decl) && decl.initializer !== undefined && isIndexRead(decl.initializer)) return decl.initializer;
  }
  // `x = arr[i]` / `dst[j] = src[k]` reported at the assignment target: assert the right side.
  for (let cur = n; cur !== undefined && !ts.isStatement(cur); cur = cur.parent) {
    if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return isIndexRead(cur.right) ? cur.right : undefined;
    }
  }
  return undefined;
}

let pass = 0;
let total = 0;
for (;;) {
  pass++;
  const p = program();
  const checker = p.getTypeChecker();
  const edits = new Map<string, Set<number>>();
  let unfixed = 0;
  for (const d of ts.getPreEmitDiagnostics(p)) {
    if (d.file === undefined || d.start === undefined || !CODES.has(d.code)) continue;
    const t = target(d.file, checker, d.start, d.length ?? 0);
    if (t === undefined) {
      unfixed++;
      continue;
    }
    const set = edits.get(d.file.fileName) ?? new Set<number>();
    set.add(t.getEnd());
    edits.set(d.file.fileName, set);
  }
  const count = [...edits.values()].reduce((n, s) => n + s.size, 0);
  console.log(`pass ${pass}: ${count} assertion(s), ${unfixed} diagnostic(s) left for a human`);
  if (count === 0 || !write) break;
  total += count;
  for (const [file, ends] of edits) {
    let text = readFileSync(file, 'utf8');
    for (const end of [...ends].sort((a, b) => b - a)) if (text[end] !== '!') text = `${text.slice(0, end)}!${text.slice(end)}`;
    writeFileSync(file, text);
  }
  if (pass > 10) break;
}
console.log(`${write ? 'added' : 'would add'} ${total} non-null assertion(s) in ${dirname(resolve(configPath))}`);
