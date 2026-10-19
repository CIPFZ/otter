import { describe, expect, it } from 'vitest';
import { renderReport, urgentCommits, type ProjectDrift } from '../lib/vendor-sync.ts';

const project: ProjectDrift = {
  project: 'hls.js',
  dir: 'vendor/hls.js',
  pinned: 'e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de',
  branch: 'HEAD',
  files: [
    { upstream: 'src/demux/tsdemuxer.ts', status: 'unchanged', commits: [] },
    {
      upstream: 'src/remux/mp4-remuxer.ts',
      status: 'changed',
      diff: '--- a/src/remux/mp4-remuxer.ts\n+++ b/src/remux/mp4-remuxer.ts\n@@ -1 +1 @@\n-old\n+new',
      commits: [
        { sha: 'aaaaaaa1', message: 'fix: Safari MSE gap at discontinuity', files: ['src/remux/mp4-remuxer.ts'] },
        { sha: 'bbbbbbb2', message: 'chore: lint', files: ['src/remux/mp4-remuxer.ts'] },
      ],
    },
  ],
};

describe('vendor drift report', () => {
  it('flags MSE / iOS / WebKit commits as urgent', () => {
    expect(urgentCommits(project.files[1] as ProjectDrift['files'][number]).map((c) => c.sha)).toEqual(['aaaaaaa1']);
  });

  it('renders the summary table, the commits and the diff', () => {
    const md = renderReport([project]);
    expect(md).toContain('1 drifted file(s), 1 with MSE / iOS / WebKit related commits');
    expect(md).toContain('| hls.js | `vendor/hls.js` | `e5ff358` | `src/remux/mp4-remuxer.ts` | changed ⚠️ urgent | 2 |');
    expect(md).toContain('- `aaaaaaa` ⚠️ fix: Safari MSE gap at discontinuity');
    expect(md).toContain('```diff\n--- a/src/remux/mp4-remuxer.ts');
  });

  it('truncates long diffs', () => {
    const long = { ...project, files: [{ ...project.files[1], diff: Array.from({ length: 10 }, (_, i) => `+${i}`).join('\n') } as ProjectDrift['files'][number]] };
    expect(renderReport([long], 3)).toContain('… 7 more lines');
  });
});
