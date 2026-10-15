// Top-level side-effect gate (AGENT §4: "sideEffects: false, no top-level side effects").
// Bundles each built package with esbuild while ignoring `sideEffects` and /* @__PURE__ */
// annotations. A module without top-level side effects tree-shakes to an empty bundle; any
// remaining code (customElements.define, DOM access, registrations, calls) is reported.
//
//   node scripts/check-side-effects.ts        (run after `pnpm build`)

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const packagesDir = join(root, 'packages');

const entries = readdirSync(packagesDir)
  .map((dir) => ({ dir, entry: join(packagesDir, dir, 'dist', 'index.js') }))
  .filter(({ dir }) => existsSync(join(packagesDir, dir, 'tsconfig.json')));

const missing = entries.filter(({ entry }) => !existsSync(entry));
if (missing.length > 0) {
  console.error(`✗ not built: ${missing.map((m) => m.dir).join(', ')}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const offenders: { dir: string; code: string }[] = [];
for (const { dir, entry } of entries) {
  const result = await build({
    stdin: { contents: `import ${JSON.stringify(entry)};`, resolveDir: root, loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    treeShaking: true,
    ignoreAnnotations: true,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const code = (result.outputFiles[0]?.text ?? '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();
  if (code !== '') offenders.push({ dir, code });
}

if (offenders.length > 0) {
  console.error(`✗ ${offenders.length} package(s) have top-level side effects:`);
  for (const { dir, code } of offenders) {
    console.error(`\n  packages/${dir}:`);
    console.error(code.split('\n').slice(0, 15).map((l) => `    ${l}`).join('\n'));
  }
  process.exit(1);
}
console.log(`✓ side effects: ${entries.length} packages tree-shake to nothing when unused`);
