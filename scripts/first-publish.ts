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
//   node scripts/first-publish.ts             use an interactive terminal; npm asks for 2FA when needed

import { setTimeout } from 'node:timers/promises';
import { runCommand } from './lib/process.ts';
import { assertInteractivePublish } from './lib/publish-input.ts';
import { npmErrorCode } from './lib/npm-error.ts';
import { runInteractiveCommand } from './lib/interactive-command.ts';
import { hasReleaseTrust } from './lib/npm-trust.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dryRun = process.argv.includes('--dry-run');
/** The workflow file trusted publishing is bound to: never rename it (ADR-014 §3). */
export const RELEASE_WORKFLOW = 'release.yml';
export const REPOSITORY = 'CIPFZ/otter';

const out = (cmd: string, args: string[]): string => runCommand(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** Runs a command; with `--dry-run` only prints it, unless `always` (the checks). */
const step = (cmd: string, args: string[], always = false): void => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  if (dryRun && !always) return;
  runCommand(cmd, args, { cwd: root, stdio: 'inherit' });
};
const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

// Reject early codes before any work; npm asks for fresh authentication at the actual publish.
try {
  assertInteractivePublish(process.argv.slice(2), process.env, process.stdin.isTTY === true, process.stdout.isTTY === true);
} catch (error) {
  fail((error as Error).message);
}

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

// Build first: the CDN license audit reads dist/inputs.json, including on a fresh clone.
// Then check license rules and release files before packing, npm --dry-run, host install and playback.
step('pnpm', ['build'], true);
step('node', ['scripts/release-files.ts', '--check'], true);
step('node', ['scripts/release-dry-run.ts'], true);

// npm/Changesets request 2FA after their own registry checks, directly before publishing.
if (!dryRun) console.log('✓ checks passed; enter a fresh code only when npm requests 2FA.');
step('pnpm', ['changeset', 'publish']);
let placeholder = true;
try {
  const publishedVersion: unknown = JSON.parse(out('npm', ['view', 'otterplayer', 'version', '--json']));
  if (typeof publishedVersion !== 'string' || publishedVersion.length === 0) throw new Error('npm view otterplayer returned an invalid version');
  placeholder = false;
} catch (error) {
  if (npmErrorCode(error) !== 'E404') throw error;
}
if (placeholder) step('npm', ['publish', join(root, 'placeholder/otterplayer'), '--access', 'public']);

// Trusted publishing: staged only (CI stages, the owner approves). Queries and registration may
// request 2FA; follow each actual prompt. Keep 2 s between registration calls (npm rate limit).
for (const p of packages) {
  let has = false;
  if (!dryRun) has = hasReleaseTrust(runInteractiveCommand('npm', ['trust', 'list', p.name, '--json'], root), REPOSITORY, RELEASE_WORKFLOW);
  if (has) {
    console.log(`${p.name}: trusted publishing already registered`);
    continue;
  }
  step('npm', ['trust', 'github', p.name, '--file', RELEASE_WORKFLOW, '--repository', REPOSITORY, '--allow-stage-publish', '--yes']);
  if (!dryRun) await setTimeout(2000);
}

console.log(dryRun ? '✓ dry run: nothing published' : `✓ published ${version}; push the tags: git push origin --tags`);
