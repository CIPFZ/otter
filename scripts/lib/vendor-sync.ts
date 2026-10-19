// Drift report model for vendored code (REUSE §5, ADR-007 §1). Pure: the script fetches, this
// module classifies and renders, so the report format is tested without network.

/** Commit messages that mean "follow within a week" (REUSE §5: MSE / iOS fixes). */
export const URGENT = /\b(mse|managedmediasource|mms|ios|ipados|iphone|safari|webkit|sourcebuffer|airplay)\b/i;

export interface UpstreamCommit {
  readonly sha: string;
  readonly message: string;
  readonly files: readonly string[];
}

export interface FileDrift {
  readonly upstream: string;
  readonly status: 'unchanged' | 'changed' | 'removed' | 'missing-at-pin';
  /** Unified diff pinned -> latest (changed only). */
  readonly diff?: string;
  /** Upstream commits between pin and branch that touched this file. */
  readonly commits: readonly UpstreamCommit[];
}

export interface SyncReview {
  /** ISO date of the review. */
  readonly date: string;
  /** Upstream ref compared against. */
  readonly upstream: string;
  readonly decision: 'merged' | 'not-merged';
  readonly reason: string;
}

export interface ProjectDrift {
  readonly project: string;
  readonly dir: string;
  readonly pinned: string;
  readonly branch: string;
  readonly files: readonly FileDrift[];
  /** False when the upstream commit list could not be fetched (API rate limit). */
  readonly commitsKnown?: boolean;
  /** Last recorded review (UPSTREAM.json syncLog). */
  readonly lastReview?: SyncReview;
}

export const urgentCommits = (f: FileDrift): UpstreamCommit[] => f.commits.filter((c) => URGENT.test(c.message));

/** Markdown report: summary table, then per drifted file the commits and the diff. */
export function renderReport(projects: readonly ProjectDrift[], maxDiffLines = 400): string {
  const out: string[] = ['# Vendored code drift report', ''];
  const drifted = projects.flatMap((p) => p.files.filter((f) => f.status === 'changed' || f.status === 'removed').map((f) => ({ p, f })));
  const urgent = drifted.filter(({ f }) => urgentCommits(f).length > 0);
  out.push(`${projects.length} vendored project dir(s), ${drifted.length} drifted file(s), ${urgent.length} with MSE / iOS / WebKit related commits (follow within a week, REUSE §5).`, '');
  out.push('| Project | Dir | Pinned | File | Status | Upstream commits |', '|---|---|---|---|---|---|');
  for (const p of projects) {
    for (const f of p.files) {
      const flag = urgentCommits(f).length > 0 ? ' ⚠️ urgent' : '';
      const commits = p.commitsKnown === false ? 'n/a (API unavailable)' : String(f.commits.length);
      out.push(`| ${p.project} | \`${p.dir}\` | \`${p.pinned.slice(0, 7)}\` | \`${f.upstream}\` | ${f.status}${flag} | ${commits} |`);
    }
  }
  for (const { p, f } of drifted) {
    out.push('', `## ${p.project}: \`${f.upstream}\` (${f.status})`, '');
    if (p.lastReview !== undefined) out.push(`Last review ${p.lastReview.date} against \`${p.lastReview.upstream.slice(0, 7)}\`: **${p.lastReview.decision}** — ${p.lastReview.reason}`, '');
    for (const c of f.commits) out.push(`- \`${c.sha.slice(0, 7)}\`${URGENT.test(c.message) ? ' ⚠️' : ''} ${c.message.split('\n')[0] ?? ''}`);
    if (f.diff !== undefined) {
      const lines = f.diff.split('\n');
      const shown = lines.slice(0, maxDiffLines);
      out.push('', '```diff', ...shown, ...(lines.length > maxDiffLines ? [`… ${lines.length - maxDiffLines} more lines`] : []), '```');
    }
  }
  return `${out.join('\n')}\n`;
}
