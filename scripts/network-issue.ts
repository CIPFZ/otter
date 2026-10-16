// Opens or updates the "Nightly @network scenarios failing" issue (ADR-004 §3). Runs in the
// nightly CI job with GH_TOKEN (issues: write); never closes the issue.
//
//   node scripts/network-issue.ts <playwright-json-report>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ISSUE_TITLE = 'Nightly @network scenarios failing';

interface PwResult {
  readonly status: string;
  readonly errors?: readonly { readonly message?: string }[];
}
interface PwSpec {
  readonly title: string;
  readonly tests: readonly { readonly projectName: string; readonly results: readonly PwResult[] }[];
}
interface PwSuite {
  readonly specs?: readonly PwSpec[];
  readonly suites?: readonly PwSuite[];
}

export interface Failure {
  readonly title: string;
  readonly project: string;
  readonly message: string;
}

const ANSI = /\u001b\[[0-9;]*m/g;

export function failuresOf(report: { readonly suites: readonly PwSuite[] }): Failure[] {
  const out: Failure[] = [];
  const walk = (suite: PwSuite): void => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const last = t.results.at(-1);
        if (last === undefined || last.status === 'passed' || last.status === 'skipped') continue;
        const message = (last.errors?.[0]?.message ?? last.status).replace(ANSI, '').split('\n')[0] ?? '';
        out.push({ title: spec.title, project: t.projectName, message: message.slice(0, 200) });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const s of report.suites) walk(s);
  return out;
}

export function issueBody(failures: readonly Failure[], runUrl: string, when: string): string {
  const rows = failures.map((f) => `| ${f.title.replace(/\|/g, '/')} | ${f.project} | ${f.message.replace(/\|/g, '/')} |`);
  return [
    `Nightly @network run failed at ${when}: ${runUrl}`,
    '',
    '| Scenario | Project | First error |',
    '|---|---|---|',
    ...rows,
    '',
    'Public test sources and the runner network are not deterministic (ADR-004 §3). Check whether this is the network or the product, then close this issue by hand.',
  ].join('\n');
}

async function gh(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const token = process.env['GH_TOKEN'];
  const repo = process.env['GITHUB_REPOSITORY'];
  if (token === undefined || repo === undefined) throw new Error('GH_TOKEN and GITHUB_REPOSITORY are required');
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined) throw new Error('usage: network-issue.ts <playwright-json-report>');
  let failures: Failure[];
  try {
    failures = failuresOf(JSON.parse(readFileSync(file, 'utf8')) as { suites: PwSuite[] });
  } catch (err) {
    failures = [{ title: '(no report)', project: '-', message: `could not read ${file}: ${String(err)}` }];
  }
  if (failures.length === 0) failures = [{ title: '(run failed without failing tests)', project: '-', message: 'see the run log' }];
  const body = issueBody(failures, process.env['RUN_URL'] ?? '(run url unknown)', new Date().toISOString());

  const open = (await gh(`/issues?state=open&per_page=100`)) as { number: number; title: string; pull_request?: unknown }[];
  const existing = open.find((i) => i.title === ISSUE_TITLE && i.pull_request === undefined);
  if (existing !== undefined) {
    await gh(`/issues/${existing.number}/comments`, { method: 'POST', body: { body } });
    console.log(`commented on #${existing.number}`);
  } else {
    const created = (await gh('/issues', { method: 'POST', body: { title: ISSUE_TITLE, body } })) as { number: number };
    console.log(`opened #${created.number}`);
  }
}

// Run only as a CLI, not when imported by tests (import.meta.main needs Node 24).
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
