// Abandoning a too-slow segment download (own CMAF-HLS engine, hls.js' abandon rules, ADR-010):
// the long ladder over a ~1 Mbps link starts at 720p (2.8 Mbps). Whether a second 720p segment
// is requested depends on whether playback had started when the ABR chose (dash.js' Throughput rule
// abstains below one segment of buffer): Chrome does request it, Firefox usually goes down right
// away. When it is requested, it cannot arrive before the buffer runs out, so the engine cancels
// it and loads 360p instead. The
// abandon is a non-fatal QoE error with its reason, also in router.explain(). Needs the bench
// ladder (e2e/media/generate-bench.sh, not committed): skipped without it.

import { existsSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

test.skip(!existsSync('e2e/media/bench/ladder/master.m3u8'), 'run e2e/media/generate-bench.sh first');

test('1 Mbps: the 720p segment in flight is abandoned for 360p, with the reason in QoE and the route', async ({ page }) => {
  test.setTimeout(90_000);
  const requested720: string[] = [];
  page.on('request', (r) => {
    if (/\/v0_\d+\.m4s/.test(r.url())) requested720.push(r.url());
  });
  await page.goto('/player.html?idle=0');
  await page.evaluate(async (u) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: u }, { autoplay: true });
  }, `/t/1000/abandon-${Date.now()}/bench/ladder/master.m3u8`);
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().videoHeight), { timeout: 40_000 }).toBe(360);
  const r = await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const errors = o.events
      .filter((e) => e.type === 'error')
      .map((e) => {
        const err = (e.payload as { error: { details: string; fatal: boolean; message?: string } }).error;
        return { details: err.details, fatal: err.fatal, message: String((err as unknown as Error).message) };
      });
    return { errors, steps: o.state().route?.steps.map((s) => s.reason) ?? [], rebufferMs: o.state().qoe.rebufferDuration };
  });
  const abandoned = r.errors.filter((e) => e.details === 'segmentAbandoned');
  test.info().annotations.push({ type: 'abandon', description: `${requested720.length} 720p segment request(s), ${abandoned.length} abandoned` });
  if (requested720.length === 1) {
    // Down before a second 720p segment: nothing to abandon.
    expect(abandoned).toEqual([]);
    expect(r.rebufferMs).toBeLessThan(1500);
    return;
  }
  expect(abandoned.length).toBeGreaterThan(0);
  expect(abandoned.every((e) => !e.fatal)).toBe(true);
  expect(abandoned[0]?.message).toMatch(/^abandon: video-0 segment needs .* -> video-2/);
  expect(r.steps.some((s) => s.startsWith('abandon: video-0'))).toBe(true);
  expect(r.errors.filter((e) => e.fatal)).toEqual([]);
  // The stall while the 720p segment came in is gone (hls.js: ~0.7 s; without abandoning: ~3.2 s).
  expect(r.rebufferMs).toBeLessThan(1500);
});
