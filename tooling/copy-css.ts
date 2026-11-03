// Build step for CSS-only packages (skins): copies src/*.css into dist/, with relative `@import`s
// inlined (ui-skin-tv builds on ui-skin-default): dist/index.css works from a plain <link> too.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const pkgDir = process.cwd();

/** The file with its relative `@import '…';` lines replaced by the files' contents (recursively). */
function inline(file: string, seen: Set<string> = new Set()): string {
  if (seen.has(file)) throw new Error(`@import cycle at ${file}`);
  seen.add(file);
  return readFileSync(file, 'utf8').replace(/^@import\s+['"](\.{1,2}\/[^'"]+)['"];\s*$/gm, (_, rel: string) => inline(resolve(dirname(file), rel), seen));
}

mkdirSync(join(pkgDir, 'dist'), { recursive: true });
for (const file of readdirSync(join(pkgDir, 'src'))) {
  if (file.endsWith('.css')) writeFileSync(join(pkgDir, 'dist', file), inline(join(pkgDir, 'src', file)));
}
