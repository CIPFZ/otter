// First publish (ADR-014 §3), on the owner's machine, once: checks, publishes every public package
// at its current version (`changeset publish`: the pre-release dist-tag, skipping versions already
// on npm, git tags made locally), publishes the `otterplayer` placeholder, then registers trusted
// publishing for every public package (GitHub Actions, workflow `release.yml`, staged publishing
// only: CI stages, the owner approves with `npm stage approve`). Later releases go through that
// workflow.
//
// Needs: npm ≥ 11.15 (`npm trust`), logged in to npm with 2FA, a clean main equal to origin/main.
//
//   node scripts/first-publish.ts --dry-run     the checks, then print what it would run
//   node scripts/first-publish.ts [--otp=123456]

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const otp = process.argv.find((a) => a.startsWith('--otp='))?.slice('--otp='.length);
/** The workflow file trusted publishing is bound to: never rename it (ADR-014 §3). */
export const RELEASE_WORKFLOW = 'release.yml';
export const REPOSITORY = 'CIPFZ/otter';

const out = (cmd: string, args: string[]): string => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** Runs a command; with `--dry-run` only prints it, unless `always` (the checks). */
const step = (cmd: string, args: string[], always = false): void => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  if (dryRun && !always) return;
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
};
const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

// Checks.
const [major = 0, minor = 0] = out('npm', ['--version']).split('.').map(Number);
if (major < 11 || (major === 11 && minor < 15)) fail(`npm ${out('npm', ['--version'])}: \`npm trust\` needs npm ≥ 11.15 (npm install -g npm@latest)`);
let user = '';
try {
  user = out('npm', ['whoami']);
} catch {
  fail('not logged in to npm (npm login)');
}
if (out('git', ['status', '--porcelain']) !== '') fail('the working tree is not clean');
if (out('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('not on main');
out('git', ['fetch', '--quiet', 'origin', 'main']);
if (out('git', ['rev-parse', 'HEAD']) !== out('git', ['rev-parse', 'origin/main'])) fail('main is not equal to origin/main');
const pre = JSON.parse(readFileSync(join(root, '.changeset/pre.json'), 'utf8')) as { mode?: string; tag?: string };
const packages = readdirSync(join(root, 'packages'))
  .filter((d) => existsSync(join(root, 'packages', d, 'package.json')))
  .map((d) => JSON.parse(readFileSync(join(root, 'packages', d, 'package.json'), 'utf8')) as { name: string; version: string; private?: boolean })
  .filter((m) => m.private !== true);
const version = packages[0]?.version ?? fail('no public package');
console.log(`npm user ${user}; ${packages.length} packages at ${version}${pre.mode === 'pre' ? `, dist-tag ${pre.tag}` : ''}`);

// The release checks: license rules and release files, then the full dry run (build, tarballs,
// npm --dry-run, host install, CDN builds in Chromium).
step('node', ['scripts/release-files.ts', '--check'], true);
step('pnpm', ['release:dry-run'], true);

// Publish.
step('pnpm', ['changeset', 'publish', ...(otp === undefined ? [] : [`--otp=${otp}`])]);
let placeholder = true;
try {
  out('npm', ['view', 'otterplayer', 'version']);
  placeholder = false;
} catch {
  // not on npm yet
}
if (placeholder) step('npm', ['publish', join(root, 'placeholder/otterplayer'), '--access', 'public', ...(otp === undefined ? [] : [`--otp=${otp}`])]);

// Trusted publishing: staged only (CI stages, the owner approves). The first call asks for 2FA;
// tick "skip 2FA for 5 minutes" there. 2 s between calls (rate limit, npm docs).
for (const p of packages) {
  let has = false;
  if (!dryRun) {
    try {
      has = out('npm', ['trust', 'list', p.name, '--json']).includes(REPOSITORY);
    } catch {
      has = false;
    }
  }
  if (has) {
    console.log(`${p.name}: trusted publishing already registered`);
    continue;
  }
  step('npm', ['trust', 'github', p.name, '--file', RELEASE_WORKFLOW, '--repository', REPOSITORY, '--allow-stage-publish', '--yes']);
  if (!dryRun) spawnSync('sleep', ['2']);
}

console.log(dryRun ? '✓ dry run: nothing published' : `✓ published ${version}; push the tags: git push origin --tags`);
