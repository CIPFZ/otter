// Docs are text: no control characters (NUL and the other C0 codes besides tab, LF, CR) in the
// Markdown, HTML, JS and JSON under docs/ and in the top-level *.md (M6: a NUL written through an
// unescaped Python string made docs/reports/M6.md a binary file for grep). Binary assets (images,
// audio) are not checked.
//
//   node scripts/check-docs-text.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const TEXT = /\.(md|html|js|mjs|json|txt|svg)$/;
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : TEXT.test(e.name) ? [join(dir, e.name)] : []));

const files = [...walk(join(root, 'docs')), ...readdirSync(root).filter((f) => f.endsWith('.md') && statSync(join(root, f)).isFile()).map((f) => join(root, f))];
const bad: string[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const [n, line] of text.split('\n').entries()) {
    const m = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(line);
    if (m !== null) bad.push(`${relative(root, file)}:${n + 1}: U+${(m[0].codePointAt(0) as number).toString(16).padStart(4, '0')} at column ${m.index + 1}`);
  }
}
if (bad.length > 0) {
  console.error(`✗ control characters in docs:\n${bad.map((b) => `  ${b}`).join('\n')}`);
  process.exit(1);
}
console.log(`✓ docs text: ${files.length} files without control characters`);
