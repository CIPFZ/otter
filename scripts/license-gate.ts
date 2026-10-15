// License gate (REUSE §5): fails when any GPL-family license enters the dependency tree, when
// LGPL appears outside decoder-* / text-ass runtime dependencies, or when a license is unknown.
//
//   node scripts/license-gate.ts [--json report.json]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runGate, type DependencyNode, type ProjectTree } from './lib/license.ts';
import { policy } from './license-policy.ts';

interface PnpmDep {
  readonly version: string;
  readonly path?: string;
  readonly dependencies?: Readonly<Record<string, PnpmDep>>;
  readonly optionalDependencies?: Readonly<Record<string, PnpmDep>>;
}

interface PnpmProject {
  readonly name: string;
  readonly path: string;
  readonly dependencies?: Readonly<Record<string, PnpmDep>>;
  readonly optionalDependencies?: Readonly<Record<string, PnpmDep>>;
  readonly peerDependencies?: Readonly<Record<string, PnpmDep>>;
  readonly devDependencies?: Readonly<Record<string, PnpmDep>>;
}

interface PackageJson {
  readonly license?: string | { readonly type?: string };
  readonly licenses?: readonly { readonly type?: string }[];
}

const { values } = parseArgs({ options: { json: { type: 'string' } } });

const readLicense = (dir: string): string | undefined => {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type !== undefined) return pkg.license.type;
  const legacy = pkg.licenses?.map((l) => l.type).filter((t) => t !== undefined);
  if (legacy !== undefined && legacy.length > 0) return legacy.length === 1 ? legacy[0] : `(${legacy.join(' OR ')})`;
  return undefined;
};

const licenseCache = new Map<string, string | undefined>();
const cachedLicense = (dir: string): string | undefined => {
  if (!licenseCache.has(dir)) licenseCache.set(dir, readLicense(dir));
  return licenseCache.get(dir);
};

const toNodes = (deps: Readonly<Record<string, PnpmDep>> | undefined): DependencyNode[] =>
  Object.entries(deps ?? {}).map(([name, dep]) => {
    // pnpm also lists optional dependencies skipped on this platform; they have no package.json.
    const dir = dep.path !== undefined && existsSync(join(dep.path, 'package.json')) ? dep.path : undefined;
    return {
      name,
      version: dep.version,
      license: dir === undefined ? undefined : cachedLicense(dir),
      workspace: dir !== undefined && dep.version.startsWith('link:') && !dir.includes('/node_modules/'),
      installed: dir !== undefined,
      dependencies: [...toNodes(dep.dependencies), ...toNodes(dep.optionalDependencies)],
    };
  });

const raw = execFileSync('pnpm', ['-r', 'ls', '--json', '--depth', 'Infinity'], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
const projects: ProjectTree[] = (JSON.parse(raw) as PnpmProject[]).map((p) => ({
  name: p.name,
  license: cachedLicense(p.path),
  prod: [...toNodes(p.dependencies), ...toNodes(p.optionalDependencies), ...toNodes(p.peerDependencies)],
  dev: toNodes(p.devDependencies),
}));

const report = runGate(projects, policy);
if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);

console.log(`license gate: ${projects.length} workspace projects, ${report.scanned} third-party packages`);
for (const [license, count] of Object.entries(report.licenses).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${license}`);
}
if (report.notInstalled.length > 0) {
  console.log(`  optional packages not installed on this platform: ${report.notInstalled.length} (listed in --json)`);
}

if (report.violations.length > 0) {
  console.error(`\n✗ ${report.violations.length} license violation(s):`);
  for (const v of report.violations) {
    console.error(`  ${v.package} [${v.license}] (${v.scope}, via ${v.owner})`);
    console.error(`    ${v.reason}`);
    console.error(`    ${v.chain.join(' > ')}`);
  }
  process.exit(1);
}
console.log('\n✓ license gate passed');
