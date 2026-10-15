// Package boundary gate: naming, ESM + sideEffects: false, core without dependencies or DOM,
// layer direction (render never depends on engine implementations), declared imports.
//
//   node scripts/check-boundaries.ts

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkBoundaries, scanImports, type PackageInfo } from './lib/boundaries.ts';

const root = join(import.meta.dirname, '..');
const packagesDir = join(root, 'packages');

// tsconfig files allow comments.
const readJsonc = (file: string): unknown =>
  JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''));

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name) ? [join(dir, e.name)] : [],
  );

const packages: PackageInfo[] = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => {
    const dir = join(packagesDir, e.name);
    const tsconfigPath = join(dir, 'tsconfig.json');
    const tsconfig = existsSync(tsconfigPath)
      ? (readJsonc(tsconfigPath) as { compilerOptions?: { lib?: string[] }; references?: { path: string }[] })
      : undefined;
    const srcDir = join(dir, 'src');
    const imports = Object.fromEntries(
      (existsSync(srcDir) ? walk(srcDir) : []).map((f) => [relative(dir, f), scanImports(readFileSync(f, 'utf8'))]),
    );
    return {
      dir: e.name,
      manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageInfo['manifest'],
      lib: tsconfig?.compilerOptions?.lib,
      references: (tsconfig?.references ?? []).map((r) => r.path.replace(/^\.\.\//, '')),
      imports,
    };
  });

const problems = checkBoundaries(packages);
if (problems.length > 0) {
  console.error(`✗ ${problems.length} boundary problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`✓ boundaries: ${packages.length} packages checked`);
