// Abandoning a too-slow segment download (own CMAF-HLS engine, hls.js' abandon rules, ADR-010).
// Needs the bench ladder (e2e/media/generate-bench.sh, not committed): skipped without it.
//
// Deterministic case (both browsers): the link is fast for the first 800 KB, then ~1 Mbps. The
// first 720p segment (the start variant) arrives at once, so the ABR estimate is high and the
// second segment is asked at 720p too; at 1 Mbps it cannot arrive before the buffer runs out, so
// the engine cancels it and loads a lower variant. The abandon is a non-fatal QoE error with its
// reason, and the same sentence is a router.explain() step.
//
// Steady 1 Mbps (the benchmark's link): whether a second 720p segment is asked depends on whether
// playback had started when the ABR chose; either way no long stall.

import { existsSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

test.skip(!existsSync('e2e/media/bench/ladder/master.m3u8'), 'run e2e/media/generate-bench.sh first');

async function play(page: Page, link: string): Promise<string[]> {
  const requested720: string[] = [];
  page.on('request', (r) => {
    if (/\/v0_\d+\.m4s/.test(r.url())) requested720.push(r.url());
  });
  await page.goto('/player.html?idle=0');
  await page.evaluate(async (u) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: u }, { autoplay: true });
  }, `/t/${link}/abandon-${Date.now()}/bench/ladder/master.m3u8`);
  return requested720;
}

const outcome = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const errors = o.events
      .filter((e) => e.type === 'error')
      .map((e) => {
        // Plain fields: Error objects lose their own properties on the way out of the page.
        const err = (e.payload as { error: { details: string; fatal: boolean } }).error;
        return { details: err.details, fatal: err.fatal, message: String((err as unknown as Error).message) };
      });
    return { errors, steps: o.state().route?.steps.map((s) => s.reason) ?? [], rebufferMs: o.state().qoe.rebufferDuration, height: o.state().videoHeight };
  });

test('link drops after the start: the second 720p segment is abandoned (QoE + explain), always', async ({ page }) => {
  test.setTimeout(90_000);
  const requested720 = await play(page, '1000+800k');
  await expect.poll(async () => (await outcome(page)).errors.some((e) => e.details === 'segmentAbandoned'), { timeout: 30_000 }).toBe(true);
  const r = await outcome(page);
  expect(requested720.length).toBeGreaterThanOrEqual(2);
  const abandoned = r.errors.filter((e) => e.details === 'segmentAbandoned');
  expect(abandoned.every((e) => !e.fatal)).toBe(true);
  const sentence = abandoned[0]?.message as string;
  expect(sentence).toMatch(/^abandon: video-0 segment needs \d+\.\d s, \d+\.\d s buffered -> video-[12] \(\d+\.\d s\)$/);
  // The same sentence in router.explain().
  expect(r.steps).toContain(sentence);
  expect(r.errors.filter((e) => e.fatal)).toEqual([]);
  await expect.poll(async () => (await outcome(page)).height, { timeout: 20_000 }).toBeLessThan(720);
});

test('steady 1 Mbps: a second 720p request, if any, is abandoned; no long stall', async ({ page }) => {
  test.setTimeout(90_000);
  const requested720 = await play(page, '1000');
  await expect.poll(async () => (await outcome(page)).height, { timeout: 40_000 }).toBe(360);
  const r = await outcome(page);
  const abandoned = r.errors.filter((e) => e.details === 'segmentAbandoned');
  test.info().annotations.push({ type: 'abandon', description: `${requested720.length} 720p segment request(s), ${abandoned.length} abandoned` });
  if (requested720.length > 1) expect(abandoned.length).toBeGreaterThan(0);
  else expect(abandoned).toEqual([]);
  // hls.js: ~0.7 s; without abandoning: ~3.2 s.
  expect(r.rebufferMs).toBeLessThan(1500);
});
