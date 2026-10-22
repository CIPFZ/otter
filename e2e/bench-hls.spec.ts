// M5 batch 1 acceptance benchmark (ADR-011 §1): the own CMAF-HLS engine against the hls.js
// adapter, same machine, same local sources, same browser. Opt-in (OTTER_BENCH=1): timing on
// shared CI runners is too noisy to gate on. Needs e2e/media/generate-bench.sh first.
//
// VOD: TTFF (load -> first frame, the session's QoE) and, over a fixed playing window, rebuffer
// count and total time and quality switches; every run in a fresh context, the two engines
// alternating; media through e2e/throttle.ts (/t/<kbps>/<session>/...: unlimited, ~3 Mbps,
// ~1 Mbps, shared by the page's requests). Short VOD: hls-fmp4 (8 s, two renditions);
// long VOD: bench/ladder (60 s, 720p / 480p / 360p at 2.8 / 1.4 / 0.77 Mbps peak).
//
// Live: e2e/live-hls.ts (HOLD-BACK 6 s). Wall latency from the picture: the frame number painted
// into the clip gives the presented place in the 30 s loop, against the source's real-time live
// point (/live-hls/clock), modulo the loop. At start, steady (15..25 s), and after a pause + back to live.
// Writes docs/reports/m5/bench-hls-<test>-<project>.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

test.skip(process.env['OTTER_BENCH'] !== '1', 'set OTTER_BENCH=1 to run the HLS engine benchmark');

const RUNS = Number(process.env['OTTER_BENCH_RUNS'] ?? 10);
const LIVE_RUNS = Number(process.env['OTTER_BENCH_LIVE_RUNS'] ?? 5);
const ENGINES = ['otter', 'hlsjs'] as const;
type EngineId = (typeof ENGINES)[number];

const quantile = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  return (s[lo] as number) + ((s[Math.ceil(at)] as number) - (s[lo] as number)) * (at - lo);
};
const stats = (xs: readonly number[]) => ({ median: Number(quantile(xs, 0.5).toFixed(2)), p90: Number(quantile(xs, 0.9).toFixed(2)), min: Math.min(...xs), max: Math.max(...xs) });

const save = (name: string, data: unknown): void => {
  mkdirSync('docs/reports/m5', { recursive: true });
  writeFileSync(`docs/reports/m5/bench-hls-${name}-${test.info().project.name}.json`, `${JSON.stringify(data, null, 2)}\n`);
};

interface VodRun {
  ttff: number;
  rebuffers: number;
  rebufferMs: number;
  switches: number;
  startHeight: number;
  endHeight: number;
  fallback: boolean;
  fatal: string[];
}

async function vodRun(browser: Browser, engine: EngineId, src: string, kbps: number, playS: number, run: number): Promise<VodRun> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/player.html?idle=0${engine === 'hlsjs' ? '&hls=hlsjs' : ''}`);
  const url = `/t/${kbps}/r${run}-${engine}-${Date.now()}/${src}`;
  await page.evaluate(async (u) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: u }, { autoplay: true });
  }, url);
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().qoe.ttff), { timeout: 60_000 }).not.toBeNull();
  const startHeight = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).videoHeight);
  // The playing window: wall time, or the end of the clip.
  const until = Date.now() + playS * 1000;
  while (Date.now() < until) {
    if (await page.evaluate(async () => ((await window.otter) as OtterFixture).state().ended)) break;
    await page.waitForTimeout(500);
  }
  const r = await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const s = o.state();
    const errors = o.events
      .filter((e) => e.type === 'error')
      .map((e) => {
        const err = (e.payload as { error: { details: string; fatal: boolean } }).error;
        return { details: err.details, fatal: err.fatal };
      });
    return {
      ttff: s.qoe.ttff as number,
      rebuffers: s.qoe.rebufferCount,
      rebufferMs: s.qoe.rebufferDuration,
      switches: o.events.filter((e) => e.type === 'quality-switch' && (e.payload as { from: string | null }).from !== null).length,
      endHeight: (document.querySelector('video') as HTMLVideoElement).videoHeight,
      fallback: errors.some((e) => e.details === 'pipelineFallback'),
      fatal: errors.filter((e) => e.fatal).map((e) => e.details),
    };
  });
  await context.close();
  return { ...r, startHeight };
}

const VOD = [
  { id: 'short-vod', src: 'hls-fmp4/master.m3u8', playS: 10 },
  { id: 'long-vod', src: 'bench/ladder/master.m3u8', playS: 30 },
] as const;
const LINKS = [
  { id: 'unlimited', kbps: 0 },
  { id: '3mbps', kbps: 3000 },
  { id: '1mbps', kbps: 1000 },
] as const;

for (const v of VOD) {
  for (const link of LINKS) {
    test(`${v.id} over ${link.id}: own engine vs hls.js, ${RUNS} runs each`, async ({ browser }) => {
      test.setTimeout(RUNS * 2 * (v.playS + 70) * 1000);
      const runs: Record<EngineId, VodRun[]> = { otter: [], hlsjs: [] };
      for (let i = 0; i < RUNS; i++) {
        // Alternate which engine goes first, so drift (caches, CPU) does not favour one.
        for (const engine of i % 2 === 0 ? ENGINES : ([...ENGINES].reverse() as EngineId[])) runs[engine].push(await vodRun(browser, engine, v.src, link.kbps, v.playS, i));
      }
      const summary = Object.fromEntries(
        ENGINES.map((e) => {
          const r = runs[e];
          return [
            e,
            {
              runs: r.length,
              ttffMs: stats(r.map((x) => x.ttff)),
              rebuffers: stats(r.map((x) => x.rebuffers)),
              rebufferMs: stats(r.map((x) => x.rebufferMs)),
              runsWithRebuffer: r.filter((x) => x.rebuffers > 0).length,
              switches: stats(r.map((x) => x.switches)),
              startHeights: r.map((x) => x.startHeight),
              endHeights: r.map((x) => x.endHeight),
              fallbacks: r.filter((x) => x.fallback).length,
              fatal: r.flatMap((x) => x.fatal),
              raw: r,
            },
          ];
        }),
      );
      save(`${v.id}-${link.id}`, { scenario: v, link, summary });
      // Only correctness is gated here: both engines play; the own engine never fell back.
      expect((summary['otter'] as { fallbacks: number }).fallbacks).toBe(0);
      expect([...runs.otter, ...runs.hlsjs].flatMap((x) => x.fatal)).toEqual([]);
    });
  }
}

/** Frame number painted in the picture (hls-ladder: 10 bits across the top, any rendition size). */
async function frameOnPlayer(page: Page): Promise<number> {
  const style = await page.addStyleTag({ content: '[data-otter-top], [data-otter-controls], [data-otter-center], [data-otter-live] { visibility: hidden !important; }' });
  const png = (await page.locator('video').screenshot({ animations: 'disabled' })).toString('base64');
  await style.evaluate((el) => (el as Element).remove());
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    // The picture is letterboxed in the element: find its rect from the aspect ratio (16:9 clip).
    const h = Math.min(img.height, (img.width * 9) / 16);
    const w = (h * 16) / 9;
    const x0 = (img.width - w) / 2;
    const y0 = (img.height - h) / 2;
    let bits = 0;
    for (let i = 0; i < 10; i++) {
      const d = ctx.getImageData(Math.floor(x0 + ((i * 48 + 24) / 640) * w), Math.floor(y0 + (24 / 360) * h), 1, 1).data;
      if ((d[0] as number) + (d[1] as number) + (d[2] as number) > 384) bits |= 1 << i;
    }
    return bits;
  }, png);
}

/**
 * Seconds from the source's live point to the presented picture: the picture's place in the 30 s
 * loop against the live point's, modulo the loop (latencies stay well under 30 s). Engine-agnostic:
 * hls.js maps the live stream onto a timeline of its own, so currentTime cannot be compared.
 */
async function wallLatency(page: Page): Promise<number> {
  const [frame, live] = await Promise.all([frameOnPlayer(page), page.evaluate(async () => ((await (await fetch('/live-hls/clock')).json()) as { live: number }).live)]);
  return (((live - frame / 30) % 30) + 30) % 30;
}

test(`live: wall latency, own engine vs hls.js, ${LIVE_RUNS} runs each`, async ({ browser }) => {
  test.setTimeout(LIVE_RUNS * 2 * 90_000);
  const runs: Record<EngineId, { startup: number; steady: number; backToLive: number; reportedMinusWall: number }[]> = { otter: [], hlsjs: [] };
  for (let i = 0; i < LIVE_RUNS; i++) {
    for (const engine of i % 2 === 0 ? ENGINES : ([...ENGINES].reverse() as EngineId[])) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`/player.html?idle=0${engine === 'hlsjs' ? '&hls=hlsjs' : ''}`);
      await page.evaluate(async () => {
        const o = (await window.otter) as OtterFixture;
        o.dispatch('set-muted', { muted: true });
        o.load({ src: '/live-hls/master.m3u8', live: true }, { autoplay: true });
      });
      await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().qoe.ttff), { timeout: 30_000 }).not.toBeNull();
      await page.waitForTimeout(1000);
      const startup = await wallLatency(page);
      await page.waitForTimeout(13_000);
      const steady: number[] = [];
      // The engine's own latency (state.latency) against the wall latency, same moments.
      const diffs: number[] = [];
      for (let k = 0; k < 10; k++) {
        const [wall, reported] = await Promise.all([wallLatency(page), page.evaluate(async () => ((await window.otter) as OtterFixture).state().latency)]);
        steady.push(wall);
        if (reported !== null) diffs.push(reported - wall);
        await page.waitForTimeout(1000);
      }
      // Paused behind the edge, then back to live.
      await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
      await page.waitForTimeout(8000);
      await page.evaluate(async () => {
        const o = (await window.otter) as OtterFixture;
        o.dispatch('seek-to-live', {});
        o.dispatch('play', undefined);
      });
      await page.waitForTimeout(3000);
      const back: number[] = [];
      for (let k = 0; k < 4; k++) {
        back.push(await wallLatency(page));
        await page.waitForTimeout(1000);
      }
      runs[engine].push({ startup, steady: quantile(steady, 0.5), backToLive: quantile(back, 0.5), reportedMinusWall: quantile(diffs, 0.5) });
      await context.close();
    }
  }
  const summary = Object.fromEntries(
    ENGINES.map((e) => [
      e,
      {
        runs: runs[e].length,
        startupS: stats(runs[e].map((r) => r.startup)),
        steadyS: stats(runs[e].map((r) => r.steady)),
        backToLiveS: stats(runs[e].map((r) => r.backToLive)),
        reportedMinusWallS: stats(runs[e].map((r) => r.reportedMinusWall)),
        raw: runs[e],
      },
    ]),
  );
  save('live', { holdBackS: 6, summary });
  for (const e of ENGINES) for (const r of runs[e]) expect(Number.isFinite(r.steady)).toBe(true);
});
