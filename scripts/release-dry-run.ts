// npm dry-run of a release (ADR-014): packs every published package the way `changeset publish`
// will (pnpm pack: `workspace:*` becomes the version), checks each tarball, asks npm for its
// dry-run report under the prerelease dist-tag, and installs all tarballs into a fresh project
// that type-checks and bundles the docs' examples (e2e/site/examples/) against them, as a host
// would; then serves @otter-player/cdn from that install and plays its two entries in Chromium,
// imported by URL as from jsDelivr. Nothing is
// published.
//
// Checked per tarball: the fixed version; no `workspace:` range and no dependency on a private
// placeholder or an `@otter-vendor/*` package; every `exports` target, LICENSE, README.md and the
// NOTICE (when the package has one) inside; no build leftovers (`.tsbuildinfo`, tests).
//
//   pnpm build && node scripts/release-dry-run.ts [--keep]     (needs the npm registry)

import { runCommand } from './lib/process.ts';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cdnSmoke } from './lib/cdn-smoke.ts';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const keep = process.argv.includes('--keep');
const work = mkdtempSync(join(tmpdir(), 'otter-release-'));
const tarballs = join(work, 'tarballs');
mkdirSync(tarballs);

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const run = (cmd: string, args: string[], cwd: string): string => runCommand(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const targets = (exports: unknown, condition?: string): string[] =>
  typeof exports === 'string'
    ? condition === '@otter-player/source'
      ? []
      : [exports]
    : typeof exports === 'object' && exports !== null
      ? Object.entries(exports).flatMap(([k, v]) => targets(v, k))
      : [];

const dirs = readdirSync(join(root, 'packages')).filter((d) => existsSync(join(root, 'packages', d, 'package.json'))).sort();
const manifests = new Map(dirs.map((d) => [d, readJson<Manifest>(join(root, 'packages', d, 'package.json'))]));
const published = dirs.filter((d) => manifests.get(d)?.private !== true);
const privateNames = new Set(dirs.filter((d) => manifests.get(d)?.private === true).map((d) => manifests.get(d)?.name));
const versions = new Set(published.map((d) => manifests.get(d)?.version));
const problems: string[] = [];
if (versions.size !== 1) problems.push(`published packages are not on one version: ${[...versions].join(', ')}`);
const version = [...versions][0] as string;
const tag = /-([a-z]+)\./.exec(version)?.[1] ?? 'latest';

const rows: string[] = [];
for (const dir of published) {
  const m = manifests.get(dir) as Manifest;
  const pkgDir = join(root, 'packages', dir);
  const out = run('pnpm', ['pack', '--pack-destination', tarballs], pkgDir);
  const tgz = out.trim().split(/\r?\n/).pop() as string;
  const files = run('tar', ['-tzf', tgz], work).split(/\r?\n/).filter((f) => f !== '').map((f) => f.replace(/^package\//, ''));
  const packed = JSON.parse(run('tar', ['-xzOf', tgz, 'package/package.json'], work)) as Manifest;
  const where = `${m.name}`;
  if (packed.version !== version) problems.push(`${where}: version ${packed.version}, not ${version}`);
  for (const [dep, range] of Object.entries({ ...packed.dependencies, ...packed.peerDependencies })) {
    if (range.startsWith('workspace:')) problems.push(`${where}: ${dep} still "${range}"`);
    if (privateNames.has(dep)) problems.push(`${where}: depends on the private placeholder ${dep}`);
    if (dep.startsWith('@otter-vendor/')) problems.push(`${where}: depends on ${dep}, which is never published`);
  }
  for (const t of targets(packed.exports)) if (!files.includes(t.replace(/^\.\//, ''))) problems.push(`${where}: exports target ${t} is not in the tarball`);
  for (const f of ['LICENSE', 'README.md', ...(existsSync(join(pkgDir, 'NOTICE')) ? ['NOTICE'] : [])]) if (!files.includes(f)) problems.push(`${where}: ${f} is not in the tarball`);
  const leftovers = files.filter((f) => /\.tsbuildinfo$|\.test\.[jt]s$|(^|\/)test\/|(^|\/)inputs\.json$/.test(f));
  if (leftovers.length > 0) problems.push(`${where}: build leftovers in the tarball: ${leftovers.slice(0, 5).join(', ')}`);
  // npm's own view: the dist-tag, access and size it would publish with.
  const report = run('npm', ['publish', tgz, '--dry-run', '--tag', tag, '--json'], work);
  const r = JSON.parse(report.slice(report.indexOf('{'))) as { size: number; unpackedSize: number; entryCount: number };
  rows.push(`${m.name.padEnd(38)} ${String(r.entryCount).padStart(4)} files ${(r.size / 1024).toFixed(1).padStart(8)} kB packed ${(r.unpackedSize / 1024).toFixed(1).padStart(8)} kB unpacked`);
}

// A host: install every tarball, type-check and bundle the docs' examples against them.
const host = join(work, 'host');
mkdirSync(join(host, 'src'), { recursive: true });
writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'otter-release-host', private: true, type: 'module' }, null, 2));
const tgzs = readdirSync(tarballs).map((f) => join(tarballs, f));
run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...tgzs, 'react@19', 'react-dom@19', '@types/react@19', 'vue@3', 'svelte@5'], host);
const examples = join(root, 'e2e/site/examples');
for (const f of readdirSync(examples)) if (/\.(ts|tsx)$/.test(f) && f !== 'sources.ts') cpSync(join(examples, f), join(host, 'src', f));
writeFileSync(
  join(host, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'], strict: true, noEmit: true, jsx: 'react-jsx', skipLibCheck: false, allowImportingTsExtensions: true, types: [] }, include: ['src'] }, null, 2),
);
let typecheck = 'passed';
try {
  run(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], host);
} catch (e) {
  typecheck = 'FAILED';
  problems.push(`host typecheck of the examples against the tarballs failed:\n${String((e as { stdout?: string }).stdout ?? e).slice(0, 4000)}`);
}
let bundle = 'passed';
try {
  for (const f of ['vod.ts', 'surveillance.ts', 'basic.ts']) {
    run(join(root, 'node_modules/.bin/esbuild'), [join('src', f), '--bundle', '--format=esm', '--platform=browser', '--loader:.css=empty', `--outfile=${join(work, 'bundle', f.replace(/\.ts$/, '.js'))}`, '--log-level=error'], host);
  }
} catch (e) {
  bundle = 'FAILED';
  problems.push(`host bundle of the examples failed:\n${String((e as { stderr?: string }).stderr ?? e).slice(0, 4000)}`);
}

// @otter-player/cdn (ADR-014 §6) as installed from its tarball, played from its URLs.
const cdn = join(host, 'node_modules/@otter-player/cdn/dist');
const cdnFiles = readdirSync(cdn, { recursive: true }).length;
const smoke = await cdnSmoke(cdn, join(root, 'e2e/media'), ['otter-basic', 'otter-vod']);
for (const s of smoke) if (s.time <= 1 || s.errors.length > 0) problems.push(`CDN ${s.name}: playhead ${s.time.toFixed(2)} s, errors ${s.errors.join('; ') || 'none'}`);

console.log(`release dry-run: ${published.length} packages at ${version}, npm dist-tag "${tag}"`);
console.log(rows.join('\n'));
console.log(`host install of all ${tgzs.length} tarballs: passed; examples typecheck: ${typecheck}; examples bundle (vod, surveillance, basic): ${bundle}`);
console.log(`@otter-player/cdn tarball: ${cdnFiles} files in dist/`);
console.log(smoke.map((s) => `CDN ${s.name} in Chromium: playhead ${s.time.toFixed(2)} s, ${s.chunks} chunks fetched, ${s.errors.length} errors`).join('\n'));
if (keep) console.log(`kept: ${work}`);
else rmSync(work, { recursive: true, force: true });
if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log('✓ release dry-run passed (nothing published)');
