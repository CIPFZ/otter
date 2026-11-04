// Stages a release on npm from CI (ADR-014 §3, workflow release.yml): packs every public package
// (pnpm pack: `workspace:*` becomes the version) and runs `npm stage publish` for each whose
// version is not on npm yet, under the pre-release dist-tag (`latest` outside pre mode). Trusted
// publishing (OIDC) authenticates; nothing is public until the owner runs `npm stage approve`.
//
//   node scripts/stage-release.ts [--dry-run]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const run = (cmd: string, args: string[], cwd = root, quiet = false): string => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'] }).trim();

const pre = JSON.parse(readFileSync(join(root, '.changeset/pre.json'), 'utf8')) as { mode?: string; tag?: string };
const tag = pre.mode === 'pre' && pre.tag !== undefined ? pre.tag : 'latest';
const dirs = readdirSync(join(root, 'packages')).filter((d) => existsSync(join(root, 'packages', d, 'package.json')));
const work = mkdtempSync(join(tmpdir(), 'otter-stage-'));
const staged: string[] = [];
const skipped: string[] = [];
for (const dir of dirs.sort()) {
  const m = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as { name: string; version: string; private?: boolean };
  if (m.private === true) continue;
  let exists = false;
  try {
    exists = run('npm', ['view', `${m.name}@${m.version}`, 'version'], root, true) === m.version;
  } catch {
    exists = false;
  }
  if (exists) {
    skipped.push(`${m.name}@${m.version}`);
    continue;
  }
  const tgz = run('pnpm', ['pack', '--pack-destination', work], join(root, 'packages', dir)).split('\n').pop() as string;
  if (!dryRun) run('npm', ['stage', 'publish', tgz, '--tag', tag]);
  staged.push(`${m.name}@${m.version}`);
}
console.log(`${dryRun ? 'would stage' : 'staged'} ${staged.length} under "${tag}"${staged.length > 0 ? `: ${staged.join(', ')}` : ''}`);
if (skipped.length > 0) console.log(`already on npm: ${skipped.length}`);
if (!dryRun && staged.length > 0) console.log('approve with: npm stage list <package>, then npm stage approve <stage-id> (2FA)');
