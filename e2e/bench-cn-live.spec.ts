// cn-live acceptance benchmark (SPEC §21 M3, ADR-007 §3): own FLV pipeline vs the mpegts.js
// adapter on the same local paced live stream, same browser. Per engine N fresh page loads;
// TTFF from the session's QoE. Latency, two ways, each the median of 6 samples taken 6..9 s after
// the first frame:
// - buffer latency: buffered end - playhead (what the LiveController steers);
// - wall latency: time since load minus media played since the first buffered sample. The local
//   origin starts every connection at stream time 0 and paces in real time (300 ms lead), so this
//   is the distance to the live edge as a viewer would see it. Opt-in (OTTER_BENCH=1): timing in shared CI runners is too noisy to gate on.
// Writes docs/reports/m3/bench-cn-live-<project>.json.

import { writeFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

test.skip(process.env['OTTER_BENCH'] !== '1', 'set OTTER_BENCH=1 to run the cn-live benchmark');

const RUNS = Number(process.env['OTTER_BENCH_RUNS'] ?? 10);
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

test('cn-live-flv: own pipeline vs mpegts.js adapter', async ({ browser }, testInfo) => {
  test.setTimeout(RUNS * 2 * 30_000);
  const result: Record<string, { ttff: number[]; latency: number[]; wall: number[]; fallback: number }> = {};
  for (const engine of ['mpegts', 'otter'] as const) {
    const r = { ttff: [] as number[], latency: [] as number[], wall: [] as number[], fallback: 0 };
    for (let i = 0; i < RUNS; i++) {
      const page = await browser.newPage();
      await page.goto(`/player.html?pipeline=${engine}`);
      await page.evaluate(async () => {
        const o = (await window.otter) as OtterFixture;
        o.dispatch('set-muted', { muted: true });
        (window as unknown as { benchT0: number }).benchT0 = performance.now();
        o.load({ src: '/live/stream.flv', live: true }, { autoplay: true });
      });
      await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().qoe.ttff), { timeout: 20_000 }).not.toBeNull();
      r.ttff.push((await page.evaluate(async () => ((await window.otter) as OtterFixture).state().qoe.ttff)) as number);
      // Stream time 0 on the media timeline: the first buffered sample.
      await page.evaluate(() => {
        const v = document.querySelector('video') as HTMLVideoElement;
        (window as unknown as { benchB0: number }).benchB0 = v.buffered.length > 0 ? v.buffered.start(0) : 0;
      });
      await page.waitForTimeout(6000);
      const samples: number[] = [];
      const wall: number[] = [];
      for (let k = 0; k < 6; k++) {
        const m = await page.evaluate(() => {
          const v = document.querySelector('video') as HTMLVideoElement;
          const w = window as unknown as { benchT0: number; benchB0: number };
          return {
            buffer: v.buffered.length > 0 ? v.buffered.end(v.buffered.length - 1) - v.currentTime : Number.NaN,
            wall: (performance.now() - w.benchT0) / 1000 - (v.currentTime - w.benchB0),
          };
        });
        samples.push(m.buffer);
        wall.push(m.wall);
        await page.waitForTimeout(500);
      }
      r.latency.push(median(samples));
      r.wall.push(median(wall));
      const errors = await page.evaluate(async () => ((await window.otter) as OtterFixture).events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string } }).error.details));
      if (errors.includes('pipelineFallback')) r.fallback++;
      await page.close();
    }
    result[engine] = r;
  }
  const summary = Object.fromEntries(
    Object.entries(result).map(([k, v]) => [
      k,
      {
        runs: v.ttff.length,
        ttffMedianMs: Math.round(median(v.ttff)),
        bufferLatencyMedianS: Number(median(v.latency).toFixed(2)),
        wallLatencyMedianS: Number(median(v.wall).toFixed(2)),
        wallLatencyMaxS: Number(Math.max(...v.wall).toFixed(2)),
        fallbacks: v.fallback,
        raw: v,
      },
    ]),
  );
  writeFileSync(`docs/reports/m3/bench-cn-live-${testInfo.project.name}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  const own = summary['otter'] as { ttffMedianMs: number; wallLatencyMaxS: number; fallbacks: number };
  const adapter = summary['mpegts'] as { ttffMedianMs: number };
  // Acceptance (SPEC §21): latency <= 2 s, TTFF not worse than the adapter (10% / 50 ms tolerance for timer noise).
  expect(own.fallbacks).toBe(0);
  expect(own.wallLatencyMaxS).toBeLessThanOrEqual(2);
  expect(own.ttffMedianMs).toBeLessThanOrEqual(Math.max(adapter.ttffMedianMs * 1.1, adapter.ttffMedianMs + 50));
});
