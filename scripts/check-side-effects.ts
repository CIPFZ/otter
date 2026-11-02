// Top-level side-effect gate (AGENT §4: "sideEffects: false, no top-level side effects").
// Bundles each built JS package with esbuild while ignoring `sideEffects` and /* @__PURE__ */
// annotations. A module without top-level side effects tree-shakes to an empty bundle; any
// remaining code (customElements.define, DOM access, registrations, calls) is reported.
//
// Third-party packages are external: only Otter's own modules are judged; so are import() targets. A static top-level
// import of a third-party value therefore fails the gate too, which keeps engine libraries
// (hls.js, Shaka, mpegts.js) behind dynamic import().
//
// Server safety (SSR, ADR-013 batch 3), for every entry: the package's index and each sub-path
// export (`@otter-player/presets/vod`, what a server bundle imports one by one):
// - no top-level class extending a browser-only global (`class X extends HTMLElement`): esbuild
//   drops them as pure, yet they throw on a server at import;
// - imported in this Node with window, document, AudioContext, ... absent (read traps), the entry
//   loads without an error and without reading any of them.
// The tree-shaking rule applies to every entry; on a sub-path, top-level values that survive are
// allowed only when declared in one of the files of SUBPATH_PURE_VALUES (pure tables that do not
// touch the browser, ADR-013 §8): each one is traced to its source file through the `//#region`
// comments of the built chunk. New ones elsewhere are still reported. A package's
// peerDependencies (react) are static imports by design.
//
// CSS-only skins declare `"sideEffects": ["*.css"]` (ADR-002, Q7). For them the gate checks that
// the JS output is empty: dist/ must contain no JavaScript at all.
//
//   node scripts/check-side-effects.ts        (run after `pnpm build`)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { build } from 'esbuild';
import { topLevelBrowserClasses } from './lib/dom-classes.ts';

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
/** The built file of each export of a package: `.` and every sub-path (their `default` condition). */
const exportsOf = (dir: string): { name: string; entry: string }[] => {
  const manifest = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8')) as { exports?: Record<string, string | { default?: string }> };
  const out = Object.entries(manifest.exports ?? {})
    .map(([key, value]) => ({ name: key === '.' ? dir : `${dir}/${key.replace(/^\.\//, '')}`, file: typeof value === 'string' ? value : value.default }))
    .filter((x): x is { name: string; file: string } => typeof x.file === 'string' && x.file.endsWith('.js'))
    .map((x) => ({ name: x.name, entry: join(packagesDir, dir, x.file) }));
  return out.length > 0 ? out : [{ name: dir, entry: join(packagesDir, dir, 'dist', 'index.js') }];
};
const entries = dirs
  .filter((dir) => !isSkin(dir) && existsSync(join(packagesDir, dir, 'tsconfig.json')))
  .flatMap((dir) => exportsOf(dir).map((e) => ({ dir: e.name, entry: e.entry })));

const missing = [
  ...entries.filter(({ entry }) => !existsSync(entry)).map((m) => m.dir),
  ...skins.filter((dir) => !existsSync(join(packagesDir, dir, 'dist', 'index.css'))),
];
if (missing.length > 0) {
  console.error(`✗ not built: ${missing.join(', ')}. Run \`pnpm build\` first.`);
  process.exit(1);
}

/**
 * Per sub-path entry, the source files whose top-level values may survive tree-shaking there
 * (ADR-013 §8): hls.js's MP4 box tables and writer (vendored, L3), the CEA-608 parser's frozen pen
 * styles (vendored), and the TV preset's key map built from input's default key map.
 */
// (mpegts.js's AMF parser adds its endianness probe, an IIFE over an ArrayBuffer, to the same two entries.)
const MP4_TABLES = ['vendor/hls.js/src/remux/mp4-generator.ts', 'vendor/hls.js/src/utils/mp4-tools.ts', 'vendor/mpegts.js/src/demux/amf-parser.ts'];
const SUBPATH_PURE_VALUES: Readonly<Record<string, readonly string[]>> = {
  'pipeline/transmux': MP4_TABLES,
  'engine-pipeline/demux': MP4_TABLES,
  'pipeline/captions': ['packages/pipeline/src/vendor/hls.js/cea-608-parser.ts'],
  'presets/tv': ['packages/presets/src/tv.ts', 'packages/input/src/index.ts'],
};

/** The source file (repo-relative, from the chunk's `//#region`) that declares `name` at the top level of one of `files`. */
function declaredIn(name: string, files: readonly string[]): string | undefined {
  const decl = new RegExp(`^(?:export\\s+)?(?:var|let|const|function|class)\\s+${name.replace(/\$/g, '\\$')}\\b`);
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((l) => decl.test(l));
    if (at < 0) continue;
    for (let i = at; i >= 0; i--) {
      // Past the end of a region: not in one (the chunk's own code).
      if (i < at && /^\/\/#endregion/.test(lines[i] as string)) break;
      const m = /^\/\/#region (.+)$/.exec(lines[i] as string);
      // Region paths are relative to the package (packages/<name>/dist/<chunk>.js).
      if (m !== null) return relative(root, join(dirname(file), '..', (m[1] as string).trim()));
    }
    return relative(root, file);
  }
  return undefined;
}

/** What survives tree-shaking in a sub-path entry outside SUBPATH_PURE_VALUES (empty: allowed). */
function unexpectedSubpathCode(entry: string, code: string, files: readonly string[]): string[] {
  const allowed = SUBPATH_PURE_VALUES[entry] ?? [];
  const out: string[] = [];
  for (const line of code.split('\n')) {
    if (!/^\S/.test(line) || /^[\]})]/.test(line)) continue;
    const name = /^(?:var|let|const|function|class)\s+([\w$]+)/.exec(line)?.[1];
    const from = name === undefined ? undefined : declaredIn(name, files);
    if (from === undefined || !allowed.includes(from.split(sep).join('/'))) out.push(`${line.slice(0, 100)}${from === undefined ? '' : `   (${from})`}`);
  }
  return out;
}

const peersOf = (dir: string): Set<string> =>
  new Set(Object.keys((JSON.parse(readFileSync(join(packagesDir, dir.split('/')[0] as string, 'package.json'), 'utf8')) as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}));

const offenders: { dir: string; code: string }[] = [];
for (const { dir, entry } of entries) {
  const peers = peersOf(dir);
  const isIndex = !dir.includes('/');
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
    metafile: true,
    plugins: [
      {
        name: 'externalize-third-party',
        setup(b) {
          b.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path.startsWith('@otter-player/') ? undefined : { path: args.path, external: true, ...(peers.has(args.path.replace(/^((?:@[^/]+\/)?[^/]+).*$/, '$1')) ? { sideEffects: false } : {}) },
          );
          // What only import() reaches does not run when the entry is imported (every package is
          // judged as its own entry anyway). Inlined, a module shared by the static and the dynamic
          // graph would come out wrapped in esbuild's lazy-init calls, read here as top-level code.
          b.onResolve({ filter: /.*/ }, (args) => (args.kind === 'dynamic-import' ? { path: args.path, external: true } : undefined));
        },
      },
    ],
  });
  const code = (result.outputFiles[0]?.text ?? '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();
  if (code !== '' && isIndex) offenders.push({ dir, code });
  if (code !== '' && !isIndex) {
    const files = Object.keys(result.metafile?.inputs ?? {}).map((f) => join(root, f)).filter((f) => existsSync(f));
    const unexpected = unexpectedSubpathCode(dir, code, files);
    if (unexpected.length > 0) offenders.push({ dir, code: `top-level code outside the allowed pure values (ADR-013 §8):\n${unexpected.join('\n')}` });
  }
  // The static graph's own files: browser-only base classes at their top level.
  for (const input of Object.keys(result.metafile?.inputs ?? {})) {
    const file = join(root, input);
    if (!file.startsWith(packagesDir) || !existsSync(file)) continue;
    const bases = topLevelBrowserClasses(readFileSync(file, 'utf8'));
    if (bases.length > 0) offenders.push({ dir, code: `${relative(root, file)}: top-level class extends ${bases.join(', ')} (throws on a server at import)` });
  }
}

// Server import: every entry in a child Node with browser-only globals trapped.
const TRAPS = ['window', 'document', 'AudioContext', 'webkitAudioContext', 'HTMLElement', 'customElements', 'requestAnimationFrame', 'location', 'MediaSource', 'VideoDecoder'];
const probe = `
const touched = [];
for (const name of ${JSON.stringify(TRAPS)}) {
  if (name in globalThis) continue;
  Object.defineProperty(globalThis, name, { configurable: true, get() { touched.push(name); return undefined; } });
}
const out = [];
for (const [dir, entry] of JSON.parse(process.argv[1])) {
  touched.length = 0;
  try {
    await import(entry);
    if (touched.length > 0) out.push([dir, 'read ' + [...new Set(touched)].join(', ') + ' at import']);
  } catch (e) {
    out.push([dir, 'import failed: ' + String(e?.stack ?? e).split('\\n').slice(0, 3).join(' | ')]);
  }
}
console.log(JSON.stringify(out));
`;
const { execFileSync } = await import('node:child_process');
const { pathToFileURL } = await import('node:url');
const serverResult = JSON.parse(
  execFileSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(entries.map((e) => [e.dir, pathToFileURL(e.entry).href]))], { cwd: root, encoding: 'utf8' }).trim().split('\n').pop() ?? '[]',
) as [string, string][];
for (const [dir, problem] of serverResult) offenders.push({ dir, code: `server import: ${problem}` });

for (const dir of skins) {
  const js = walk(join(packagesDir, dir, 'dist')).filter((f) => /\.(js|mjs|cjs)$/.test(f));
  if (js.length > 0) {
    offenders.push({ dir, code: `skin dist must contain no JavaScript: ${js.map((f) => relative(root, f)).join(', ')}` });
  }
}

if (offenders.length > 0) {
  console.error(`✗ ${offenders.length} entr${offenders.length === 1 ? 'y has' : 'ies have'} top-level side effects:`);
  for (const { dir, code } of offenders) {
    console.error(`\n  packages/${dir}:`);
    console.error(code.split('\n').slice(0, 15).map((l) => `    ${l}`).join('\n'));
  }
  process.exit(1);
}
console.log(
  `✓ side effects: ${entries.filter((e) => !e.dir.includes('/')).length} JS packages tree-shake to nothing when unused (sub-paths: only the allowed pure values, ${Object.keys(SUBPATH_PURE_VALUES).length} entries); ${entries.length} entries (indexes and sub-paths) import on a server without browser globals; ${skins.length} skins ship no JS`,
);
