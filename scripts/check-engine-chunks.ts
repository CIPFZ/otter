// Engine chunk gate (ADR-004 §2): engine libraries (hls.js, Shaka, mpegts.js, WASM decoders) may
// only be reached through import(), never from the first-screen chunk. Bundles every SPEC §19
// scenario entry with code splitting and fails if an engine module lands in an entry chunk.
//
//   node scripts/check-engine-chunks.ts        (run after `pnpm build`)

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const sizeDir = join(root, 'tooling', 'size');

/** node_modules path fragments of engine libraries. */
const ENGINE_PATHS = ['/hls.js/', '/shaka-player/', '/mpegts.js/'];
const isEngine = (input: string): boolean => ENGINE_PATHS.some((p) => input.replace(/\\/g, '/').includes(`/node_modules${p}`));

const entries = readdirSync(sizeDir)
  .filter((f) => f.startsWith('scenario-') && f.endsWith('.js'))
  .map((f) => join(sizeDir, f));

const result = await build({
  entryPoints: entries,
  bundle: true,
  splitting: true,
  format: 'esm',
  write: false,
  outdir: join(root, 'node_modules', '.cache', 'engine-chunks'),
  metafile: true,
  minify: true,
  logLevel: 'silent',
  loader: { '.css': 'empty' },
});

// esbuild also sets `entryPoint` on chunks it creates for import() targets, so first-screen
// chunks are the outputs of our scenario entries plus every chunk they import statically.
const scenarioEntries = new Set(entries.map((e) => relative(root, e).replace(/\\/g, '/')));
const outputs = result.metafile.outputs;
const firstScreen = new Set<string>();
const visit = (file: string): void => {
  if (firstScreen.has(file)) return;
  firstScreen.add(file);
  for (const i of outputs[file]?.imports ?? []) if (i.kind === 'import-statement' && i.path in outputs) visit(i.path);
};
for (const [file, output] of Object.entries(outputs)) {
  if (output.entryPoint !== undefined && scenarioEntries.has(output.entryPoint.replace(/\\/g, '/'))) visit(file);
}

const problems: string[] = [];
let lazyEngines = 0;
for (const [file, output] of Object.entries(outputs)) {
  const engines = Object.keys(output.inputs).filter(isEngine);
  if (engines.length === 0) continue;
  if (firstScreen.has(file)) {
    problems.push(`${relative(root, file)}: first-screen chunk contains engine module(s), e.g. ${engines[0]}`);
  } else {
    lazyEngines++;
  }
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} engine chunk problem(s) (engines must load via import(), ADR-004):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
if (lazyEngines === 0) {
  console.error('✗ no lazily loaded engine chunk found; the check is not seeing the engines (path change?)');
  process.exit(1);
}
console.log(`✓ engine chunks: ${entries.length} scenario entries, engines only in ${lazyEngines} lazy chunk(s)`);
