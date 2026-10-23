// Abandoning a too-slow segment download (own CMAF-HLS engine, hls.js' abandon rules, ADR-010).
//
// Deterministic case (both browsers, every CI run; e2e/media/hls-abandon: 360p at 1.6 Mbps first,
// 180p at 0.25 Mbps): the link is fast for the first 500 KB, then ~600 kbps. The first 360p
// segment (the start variant) arrives at once, so the ABR estimate is high and the second segment
// is asked at 360p too; at 600 kbps (~5.8 s for its 430 KB) it cannot arrive before the buffer
// runs out, so the engine cancels it and loads 180p. The abandon is a non-fatal QoE error with its
// reason, and the same sentence is a router.explain() step.
//
// Steady 1 Mbps on the benchmark's long ladder (e2e/media/generate-bench.sh, not committed;
// skipped without it): whether a second 720p segment is asked depends on whether playback had
// started when the ABR chose; either way no long stall.

import { existsSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

async function play(page: Page, link: string, src = 'bench/ladder/master.m3u8'): Promise<string[]> {
  const requestedTop: string[] = [];
  page.on('request', (r) => {
    if (/\/v0_\d+\.m4s/.test(r.url())) requestedTop.push(r.url());
  });
  await page.goto('/player.html?idle=0');
  await page.evaluate(async (u) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: u }, { autoplay: true });
  }, `/t/${link}/abandon-${Date.now()}/${src}`);
  return requestedTop;
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

test('link drops after the start: the second top-variant segment is abandoned (QoE + explain), always', async ({ page }) => {
  test.setTimeout(90_000);
  const requested720 = await play(page, '600+500k', 'hls-abandon/master.m3u8');
  await expect.poll(async () => (await outcome(page)).errors.some((e) => e.details === 'segmentAbandoned'), { timeout: 30_000 }).toBe(true);
  const r = await outcome(page);
  expect(requested720.length).toBeGreaterThanOrEqual(2);
  const abandoned = r.errors.filter((e) => e.details === 'segmentAbandoned');
  expect(abandoned.every((e) => !e.fatal)).toBe(true);
  const sentence = abandoned[0]?.message as string;
  expect(sentence).toMatch(/^abandon: video-0 segment needs \d+\.\d s, \d+\.\d s buffered -> video-1 \(\d+\.\d s\)$/);
  // The same sentence in router.explain().
  expect(r.steps).toContain(sentence);
  expect(r.errors.filter((e) => e.fatal)).toEqual([]);
  await expect.poll(async () => (await outcome(page)).height, { timeout: 20_000 }).toBe(180);
});

test('steady 1 Mbps: a second 720p request, if any, is abandoned; no long stall', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(!existsSync('e2e/media/bench/ladder/master.m3u8'), 'run e2e/media/generate-bench.sh first');
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
