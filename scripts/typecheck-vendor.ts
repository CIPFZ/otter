// Strict type check of every L2 vendor package (ADR-007 §1, REUSE §5: vendored code passes strict
// TS). Each vendor/<project>/tsconfig.json is checked on its own (they are not composite projects).
//
//   node scripts/typecheck-vendor.ts

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const vendor = join(root, 'vendor');
const dirs = existsSync(vendor) ? readdirSync(vendor).filter((d) => existsSync(join(vendor, d, 'tsconfig.json'))) : [];
let failed = 0;
for (const d of dirs) {
  const r = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(vendor, d, 'tsconfig.json')], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
if (failed > 0) process.exit(1);
console.log(`✓ vendor typecheck: ${dirs.length} package(s)`);
