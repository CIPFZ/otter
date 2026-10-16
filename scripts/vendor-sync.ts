// Upstream drift report for vendored code (REUSE §5): compares each file at the pinned commit with
// the upstream default branch. Needs network; runs in the scheduled CI job and never blocks.
//
//   node scripts/vendor-sync.ts [--branch main]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { Upstream } from './lib/vendor.ts';

const root = join(import.meta.dirname, '..');
const { values } = parseArgs({ options: { branch: { type: 'string' } } });

const manifests: string[] = [];
const scan = (dir: string): void => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else if (e.name === 'UPSTREAM.json' && p.includes(`${'/'}vendor${'/'}`)) manifests.push(p);
  }
};
for (const top of ['vendor', 'e2e', 'packages']) scan(join(root, top));

const raw = (repo: string, ref: string, path: string): string => {
  const slug = repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  return `https://raw.githubusercontent.com/${slug}/${ref}/${path}`;
};

const fetchText = async (url: string): Promise<string | undefined> => {
  const res = await fetch(url);
  return res.ok ? await res.text() : undefined;
};

let drifted = 0;
for (const manifest of manifests) {
  const u = JSON.parse(readFileSync(manifest, 'utf8')) as Upstream;
  const branch = values.branch ?? 'HEAD';
  console.log(`\n${u.project} @ ${u.commit.slice(0, 7)} (${relative(root, join(manifest, '..'))})`);
  for (const upstreamPath of new Set(u.files.map((f) => f.upstream))) {
    const [pinned, latest] = await Promise.all([fetchText(raw(u.repo, u.commit, upstreamPath)), fetchText(raw(u.repo, branch, upstreamPath))]);
    if (pinned === undefined) {
      console.log(`  ? ${upstreamPath}: not found at the pinned commit`);
    } else if (latest === undefined) {
      console.log(`  ! ${upstreamPath}: removed or moved on ${branch}`);
      drifted++;
    } else if (latest !== pinned) {
      console.log(`  ~ ${upstreamPath}: changed on ${branch}; review and re-sync within a week if it is an MSE / iOS fix`);
      drifted++;
    } else {
      console.log(`  = ${upstreamPath}: unchanged`);
    }
  }
}
console.log(`\n${manifests.length} vendored project dir(s), ${drifted} upstream file(s) drifted`);
