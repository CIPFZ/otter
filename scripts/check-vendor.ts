// Vendoring gate (REUSE §5, ADR-003 §7): every copied file carries its source header and is
// listed in UPSTREAM.json; only Apache / MIT / BSD code is copied; every copied project and every
// third-party runtime dependency (L1) is recorded in REUSE.md and THIRD_PARTY_NOTICES.md.
//
//   node scripts/check-vendor.ts

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkVendor, type RuntimeDependency, type VendorDir } from './lib/vendor.ts';

const root = join(import.meta.dirname, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' || e.name === 'dist' ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

/** Directories that hold vendored code: vendor/<project>, packages/<pkg>/src/vendor/<project>, e2e/vendor/<project>. */
const candidateParents = [
  join(root, 'vendor'),
  join(root, 'e2e', 'vendor'),
  ...readdirSync(join(root, 'packages')).map((p) => join(root, 'packages', p, 'src', 'vendor')),
].filter((d) => existsSync(d));

const vendorDirs: VendorDir[] = [];
const strays: string[] = [];
for (const parent of candidateParents) {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const dir = join(parent, entry.name);
    if (!entry.isDirectory()) {
      strays.push(relative(root, dir));
      continue;
    }
    const manifest = join(dir, 'UPSTREAM.json');
    const files = walk(dir).map((f) => relative(dir, f)).filter((f) => f !== 'UPSTREAM.json');
    let upstream: unknown;
    try {
      upstream = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : undefined;
    } catch (err) {
      upstream = `invalid JSON: ${String(err)}`;
    }
    vendorDirs.push({
      dir: relative(root, dir),
      upstream,
      files,
      contents: Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')])),
    });
  }
}

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}
const runtimeDependencies: RuntimeDependency[] = readdirSync(join(root, 'packages')).flatMap((p) => {
  const file = join(root, 'packages', p, 'package.json');
  if (!existsSync(file)) return [];
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  return Object.keys({ ...m.dependencies, ...m.peerDependencies })
    // Workspace packages are not third-party: @otter-player/* is ours, and @otter-vendor/* are the L2
    // copies, which this script checks as vendor dirs (UPSTREAM.json, headers, notices) above.
    .filter((name) => !name.startsWith('@otter-player/') && !(name.startsWith('@otter-vendor/') && m.dependencies?.[name] === 'workspace:*'))
    .map((name) => ({ pkg: m.name, name }));
});

const problems = [
  ...strays.map((s) => `${s}: vendor directories may only contain per-project folders`),
  ...checkVendor({
    vendorDirs,
    notices: readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    reuse: readFileSync(join(root, 'REUSE.md'), 'utf8'),
    runtimeDependencies,
  }),
];

if (problems.length > 0) {
  console.error(`✗ ${problems.length} vendoring problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
const copied = vendorDirs.reduce((n, d) => n + d.files.length, 0);
console.log(
  `✓ vendor: ${vendorDirs.length} vendored project dir(s), ${copied} file(s); ${new Set(runtimeDependencies.map((d) => d.name)).size} L1 runtime dependencies recorded`,
);
