// ESM builds for the CDN (ADR-014 §6): `presets/basic` and `presets/vod`, each one module to
// import (`otter-basic.esm.js`, `otter-vod.esm.js`) with the third-party and workspace code it
// always needs inlined, and its on-demand parts (engines, captions, preview pictures, the WebCodecs
// path) as chunks beside it, loaded by relative URL only when used: inlining them makes a 2.8 MB
// "single file" (hls.js, Shaka, mediabunny...), most of which a page never runs. Minified, with
// the skin's stylesheet next to it. Built from the packages' dist (the build of @otter-player/cdn,
// after presets and the skins), into <outDir>/<name>/:
//   otter-basic/otter-basic.esm.js + chunks + otter-basic.css (ui-skin-minimal)
//   otter-vod/otter-vod.esm.js + chunks + otter-vod.css (ui-skin-default)
// and <outDir>/inputs.json, every source file built in (the license audit and NOTICE of the
// package, scripts/release-files.ts). Published as @otter-player/cdn (jsDelivr's npm path).
//
//   node scripts/build-cdn.ts [outDir]      (default packages/cdn/dist)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, type Plugin } from 'esbuild';

const root = join(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? join(root, 'packages/cdn/dist'));

/** `@otter-player/<pkg>[/<sub>]` → that export's built file (its `default` condition). */
const workspace: Plugin = {
  name: 'otter-workspace',
  setup(b) {
    b.onResolve({ filter: /^@otter-player\// }, (args) => {
      const [, pkg, ...sub] = args.path.split('/');
      const dir = join(root, 'packages', pkg as string);
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports: Record<string, string | Record<string, string>> };
      const key = sub.length === 0 ? '.' : `./${sub.join('/')}`;
      const entry = manifest.exports[key];
      const target = typeof entry === 'string' ? entry : (entry?.['default'] ?? entry?.['style']);
      if (target === undefined) return { errors: [{ text: `${args.path}: no such export` }] };
      return { path: join(dir, target) };
    });
  },
};

const bundles = [
  { name: 'otter-basic', entry: '@otter-player/presets/basic', skin: 'ui-skin-minimal' },
  { name: 'otter-vod', entry: '@otter-player/presets/vod', skin: 'ui-skin-default' },
] as const;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const inputs = new Set<string>();
for (const b of bundles) {
  const dir = join(out, b.name);
  const file = join(dir, `${b.name}.esm.js`);
  const result = await build({
    stdin: { contents: `export * from '${b.entry}';\n`, resolveDir: root, sourcefile: `${b.name}.ts`, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome110', 'firefox115', 'safari16.4'],
    minify: true,
    splitting: true,
    legalComments: 'eof',
    outdir: dir,
    entryNames: b.name + '.esm',
    chunkNames: 'chunks/[name]-[hash]',
    metafile: true,
    plugins: [workspace],
    absWorkingDir: root,
    logLevel: 'error',
  });
  for (const f of Object.keys(result.metafile.inputs)) if (f !== '<stdin>') inputs.add(relative(root, resolve(root, f)).replaceAll('\\', '/'));
  const css = join(root, 'packages', b.skin, 'dist', 'index.css');
  if (!existsSync(css)) throw new Error(`${b.skin} is not built: run pnpm build`);
  copyFileSync(css, join(dir, `${b.name}.css`));
  const outputs = Object.keys(result.metafile.outputs).filter((f) => f.endsWith('.js'));
  const gz = (f: string): number => gzipSync(readFileSync(f)).length / 1024;
  const total = outputs.reduce((n, f) => n + gz(join(root, f)), 0);
  console.log(`${b.name}.esm.js  ${(statSync(file).size / 1024).toFixed(1)} kB, ${gz(file).toFixed(1)} kB gzip; ${outputs.length - 1} on-demand chunks, ${total.toFixed(1)} kB gzip in all  (+ ${b.name}.css from ${b.skin})`);
}
writeFileSync(join(out, 'inputs.json'), `${JSON.stringify([...inputs].sort(), null, 1)}\n`);
