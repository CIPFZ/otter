// Build step for CSS-only packages (skins): copies src/*.css into dist/ unchanged.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = process.cwd();
mkdirSync(join(pkgDir, 'dist'), { recursive: true });
for (const file of readdirSync(join(pkgDir, 'src'))) {
  if (file.endsWith('.css')) cpSync(join(pkgDir, 'src', file), join(pkgDir, 'dist', file));
}
