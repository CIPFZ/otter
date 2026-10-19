// Upstream drift report for vendored code (REUSE §5, ADR-007 §1): for every UPSTREAM.json, compares
// each copied file at the pinned commit with the upstream branch, lists the upstream commits that
// touched it (flagging MSE / iOS / WebKit fixes) and writes unified diffs. Needs network; runs in
// the scheduled CI job and never blocks. GITHUB_TOKEN (optional) raises the API rate limit.
//
//   node scripts/vendor-sync.ts [--branch main] [--out vendor-sync-report.md]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { Upstream } from './lib/vendor.ts';
import { renderReport, type FileDrift, type ProjectDrift, type UpstreamCommit } from './lib/vendor-sync.ts';

const root = join(import.meta.dirname, '..');
const { values } = parseArgs({ options: { branch: { type: 'string' }, out: { type: 'string' } } });

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

const slugOf = (repo: string): string => repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
const headers: Record<string, string> = { 'User-Agent': 'otter-vendor-sync', Accept: 'application/vnd.github+json' };
if (process.env['GITHUB_TOKEN']) headers['Authorization'] = `Bearer ${process.env['GITHUB_TOKEN']}`;

const fetchText = async (url: string): Promise<string | undefined> => {
  const res = await fetch(url, { headers: { 'User-Agent': 'otter-vendor-sync' } });
  return res.ok ? await res.text() : undefined;
};

/** Commits between pinned and branch with the files they touched (GitHub compare API). */
async function compare(slug: string, pinned: string, branch: string): Promise<UpstreamCommit[] | undefined> {
  const res = await fetch(`https://api.github.com/repos/${slug}/compare/${pinned}...${branch}`, { headers });
  // Rate limit (no token) or unknown ref: say so in the report instead of "no commits".
  if (!res.ok) return undefined;
  const body = (await res.json()) as { commits?: { sha: string; commit: { message: string } }[] };
  const commits: UpstreamCommit[] = [];
  // The compare payload has no per-commit file list; fetch it for the (usually few) commits.
  for (const c of (body.commits ?? []).slice(-250)) {
    const r = await fetch(`https://api.github.com/repos/${slug}/commits/${c.sha}`, { headers });
    const files = r.ok ? (((await r.json()) as { files?: { filename: string }[] }).files ?? []).map((f) => f.filename) : [];
    commits.push({ sha: c.sha, message: c.commit.message, files });
  }
  return commits;
}

function unifiedDiff(a: string, b: string, path: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-sync-'));
  try {
    writeFileSync(join(dir, 'pinned'), a);
    writeFileSync(join(dir, 'latest'), b);
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--unified=3', 'pinned', 'latest'], { cwd: dir, encoding: 'utf8' });
    return r.stdout
      .split('\n')
      .filter((l) => !l.startsWith('diff --git ') && !l.startsWith('index '))
      .join('\n')
      .replace(/^(---|\+\+\+) (a|b)\/(pinned|latest)/gm, (_m, sign: string, side: string) => `${sign} ${side}/${path}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const projects: ProjectDrift[] = [];
for (const manifest of manifests) {
  const u = JSON.parse(readFileSync(manifest, 'utf8')) as Upstream;
  const slug = slugOf(u.repo);
  const branch = values.branch ?? 'HEAD';
  const raw = (ref: string, path: string): string => `https://raw.githubusercontent.com/${slug}/${ref}/${path}`;
  const commits = await compare(slug, u.commit, branch);
  const files: FileDrift[] = [];
  for (const upstreamPath of new Set(u.files.map((f) => f.upstream))) {
    const [pinned, latest] = await Promise.all([fetchText(raw(u.commit, upstreamPath)), fetchText(raw(branch, upstreamPath))]);
    const touching = (commits ?? []).filter((c) => c.files.includes(upstreamPath));
    if (pinned === undefined) files.push({ upstream: upstreamPath, status: 'missing-at-pin', commits: touching });
    else if (latest === undefined) files.push({ upstream: upstreamPath, status: 'removed', commits: touching });
    else if (latest !== pinned) files.push({ upstream: upstreamPath, status: 'changed', diff: unifiedDiff(pinned, latest, upstreamPath), commits: touching });
    else files.push({ upstream: upstreamPath, status: 'unchanged', commits: touching });
  }
  const lastReview = u.syncLog?.at(-1);
  projects.push({ project: u.project, dir: relative(root, join(manifest, '..')), pinned: u.commit, branch, files, commitsKnown: commits !== undefined, ...(lastReview === undefined ? {} : { lastReview }) });
}

const report = renderReport(projects);
if (values.out !== undefined) writeFileSync(values.out, report);
console.log(report);
