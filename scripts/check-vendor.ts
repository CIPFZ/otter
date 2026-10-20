// Vendoring source records (REUSE §5, ADR-008 §1): every copied file carries its source header and
// is listed in UPSTREAM.json, and every copied project is in REUSE.md, so vendor-sync can follow
// upstream fixes. No license checks (ADR-008).
//
//   node scripts/check-vendor.ts

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkVendor, type VendorDir } from './lib/vendor.ts';

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
      hashes: Object.fromEntries(files.map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')])),
    });
  }
}

const problems = [
  ...strays.map((s) => `${s}: vendor directories may only contain per-project folders`),
  ...checkVendor({ vendorDirs, reuse: readFileSync(join(root, 'REUSE.md'), 'utf8') }),
];

if (problems.length > 0) {
  console.error(`✗ ${problems.length} vendoring problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
const copied = vendorDirs.reduce((n, d) => n + d.files.length, 0);
console.log(`✓ vendor: ${vendorDirs.length} vendored project dir(s), ${copied} file(s) with source records`);
