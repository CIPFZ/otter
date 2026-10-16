import { describe, expect, it } from 'vitest';
import { failuresOf, issueBody } from '../network-issue.ts';

const ESC = '';
const report = {
  suites: [
    {
      suites: [
        {
          specs: [
            {
              title: 'live-ll-dash @network',
              tests: [
                {
                  projectName: 'desktop-chrome',
                  results: [{ status: 'failed', errors: [{ message: `${ESC}[31mError: expect(received).not.toBeNull()${ESC}[39m\nmore` }] }],
                },
              ],
            },
            // Retried and then passed: not a failure.
            { title: 'live-ll-hls @network', tests: [{ projectName: 'desktop-chrome', results: [{ status: 'failed' }, { status: 'passed' }] }] },
            { title: 'skipped @network', tests: [{ projectName: 'desktop-firefox', results: [{ status: 'skipped' }] }] },
          ],
        },
      ],
    },
  ],
};

describe('network issue', () => {
  it('collects tests whose last attempt failed, without ANSI codes', () => {
    expect(failuresOf(report)).toEqual([
      { title: 'live-ll-dash @network', project: 'desktop-chrome', message: 'Error: expect(received).not.toBeNull()' },
    ]);
  });

  it('renders a table with the run link', () => {
    const body = issueBody(failuresOf(report), 'https://x/run/1', '2026-10-16T03:17:00Z');
    expect(body).toContain('https://x/run/1');
    expect(body).toContain('| live-ll-dash @network | desktop-chrome | Error: expect(received).not.toBeNull() |');
  });
});
