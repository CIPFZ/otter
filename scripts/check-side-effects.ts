// Top-level side-effect gate (AGENT §4: "sideEffects: false, no top-level side effects").
// Bundles each built JS package with esbuild while ignoring `sideEffects` and /* @__PURE__ */
// annotations. A module without top-level side effects tree-shakes to an empty bundle; any
// remaining code (customElements.define, DOM access, registrations, calls) is reported.
//
// Third-party packages are external: only Otter's own modules are judged. A static top-level
// import of a third-party value therefore fails the gate too, which keeps engine libraries
// (hls.js, Shaka, mpegts.js) behind dynamic import().
//
// CSS-only skins declare `"sideEffects": ["*.css"]` (ADR-002, Q7). For them the gate checks that
// the JS output is empty: dist/ must contain no JavaScript at all.
//
//   node scripts/check-side-effects.ts        (run after `pnpm build`)

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const packagesDir = join(root, 'packages');

const isSkin = (dir: string): boolean => dir.startsWith('ui-skin-');
const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      )
    : [];

const dirs = readdirSync(packagesDir).sort();
const skins = dirs.filter(isSkin);
const entries = dirs
  .filter((dir) => !isSkin(dir) && existsSync(join(packagesDir, dir, 'tsconfig.json')))
  .map((dir) => ({ dir, entry: join(packagesDir, dir, 'dist', 'index.js') }));

const missing = [
  ...entries.filter(({ entry }) => !existsSync(entry)).map((m) => m.dir),
  ...skins.filter((dir) => !existsSync(join(packagesDir, dir, 'dist', 'index.css'))),
];
if (missing.length > 0) {
  console.error(`✗ not built: ${missing.join(', ')}. Run \`pnpm build\` first.`);
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
    plugins: [
      {
        name: 'externalize-third-party',
        setup(b) {
          b.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path.startsWith('@otter-player/') ? undefined : { path: args.path, external: true },
          );
        },
      },
    ],
  });
  const code = (result.outputFiles[0]?.text ?? '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();
  if (code !== '') offenders.push({ dir, code });
}

for (const dir of skins) {
  const js = walk(join(packagesDir, dir, 'dist')).filter((f) => /\.(js|mjs|cjs)$/.test(f));
  if (js.length > 0) {
    offenders.push({ dir, code: `skin dist must contain no JavaScript: ${js.map((f) => relative(root, f)).join(', ')}` });
  }
}

if (offenders.length > 0) {
  console.error(`✗ ${offenders.length} package(s) have top-level side effects:`);
  for (const { dir, code } of offenders) {
    console.error(`\n  packages/${dir}:`);
    console.error(code.split('\n').slice(0, 15).map((l) => `    ${l}`).join('\n'));
  }
  process.exit(1);
}
console.log(
  `✓ side effects: ${entries.length} JS packages tree-shake to nothing when unused; ${skins.length} skins ship no JS`,
);
