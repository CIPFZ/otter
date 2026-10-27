// Danmaku performance (ADR-012, M5 acceptance): 5000 comments a minute over a playing video,
// 1280x720 player. Frame pacing from requestAnimationFrame intervals and main-thread long tasks
// (PerformanceObserver 'longtask' where the browser has it; elsewhere gaps > 50 ms).
// Each case first measures a baseline on the same page (video playing, no comments, 6 s), then
// the comments (20 s), so a machine's own pacing is not counted as the engine's.
// - Local (OTTER_BENCH=1, a machine of its own, --workers=1): asserted, rAF p95 < 20 ms and no
//   long tasks; writes docs/reports/m5/bench-danmaku-<renderer>-<project>.json.
// - CI (one worker: Chrome in the bench step, WebKit in its own step): a notice only, with the
//   relative criterion accepted for CI's WebKit VM (ADR-012 §5): main-thread danmaku cost p95 < 4
//   ms and rAF p95 at most 30 % above the baseline. Real devices: M7.
// @bench: never in the parallel suite.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const PER_MINUTE = 5000;
const BASELINE_S = 6;
const WINDOW_S = 20;
/** CI-relative criterion (ADR-012 §5). */
const MAX_COST_P95_MS = 4;
const MAX_RAF_P95_OVER_BASELINE = 0.3;

interface Pacing {
  readonly frames: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly gapsOver50: number;
  readonly longTasks: number | null;
  readonly longestTask: number;
  readonly onStage: number;
  readonly peakOnStage: number;
}

for (const renderer of ['canvas2d', 'webgl', 'worker'] as const) {
  test(`danmaku ${PER_MINUTE}/min on ${renderer}: rAF p95 < 20 ms, no long tasks @bench`, async ({ page }) => {
    test.skip(test.info().project.name.startsWith('emulated'), 'desktop browsers (phones: M7 real devices)');
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`/player.html?idle=0&danmaku=1&renderer=${renderer}`);
    await page.evaluate(async () => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('set-muted', { muted: true });
      o.load({ src: '/frames/hls-ladder/master.m3u8' }, { autoplay: true });
    });
    await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().currentTime), { timeout: 20_000 }).toBeGreaterThan(1);
    const status = () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().danmakuStatus);
    // The WebGL / Worker chunks load on demand: chosen, or rejected.
    await expect.poll(async () => { const x = await status(); return x.renderer === renderer || x.steps.some((y) => y.candidate === renderer && y.outcome === 'rejected'); }, { timeout: 10_000 }).toBe(true);
    const st = await status();
    if (st.renderer !== renderer) {
      const why = [...st.steps].reverse().find((x) => x.candidate === renderer)?.reason ?? 'not selected';
      ciNotice(`danmaku bench ${renderer}: not available here (${why}, skipped)`);
      test.skip(true, `${renderer}: ${why}`);
    }
    const measure = (windowS: number): Promise<Pacing> =>
      page.evaluate(async (s) => {
        const o = (await window.otter) as OtterFixture;
        const intervals: number[] = [];
        const longTasks: number[] = [];
        let observer: PerformanceObserver | undefined;
        const supportsLongTask = PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
        if (supportsLongTask) {
          observer = new PerformanceObserver((l) => {
            for (const e of l.getEntries()) longTasks.push(e.duration);
          });
          observer.observe({ type: 'longtask' });
        }
        const running: number[] = [];
        await new Promise<void>((resolve) => {
          let last = 0;
          const end = performance.now() + s * 1000;
          const step = (t: number): void => {
            if (last > 0) intervals.push(t - last);
            last = t;
            if (intervals.length % 30 === 0) running.push(o.danmaku()?.running.length ?? 0);
            if (t < end) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });
        observer?.disconnect();
        const sorted = [...intervals].sort((a, b) => a - b);
        const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
        return {
          frames: intervals.length,
          p50: q(0.5),
          p95: q(0.95),
          max: sorted.at(-1) as number,
          gapsOver50: intervals.filter((i) => i > 50).length,
          longTasks: supportsLongTask ? longTasks.length : null,
          longestTask: longTasks.length > 0 ? Math.max(...longTasks) : 0,
          onStage: running.length > 0 ? Math.round(running.reduce((a, b) => a + b, 0) / running.length) : 0,
          peakOnStage: Math.max(0, ...running),
        };
      }, windowS);

    const baseline = await measure(BASELINE_S);
    await page.evaluate(async (perMinute) => {
      const o = (await window.otter) as OtterFixture;
      // Deterministic pseudo-random comments over the whole 30 s clip: lengths 4-20, mixed CJK /
      // Latin, B站 mode mix.
      let seed = 7;
      const rnd = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
      const glyphs = '弹幕测试前方高能哈哈哈awesome2333好看再来一遍yyds';
      const comments = Array.from({ length: Math.round((perMinute / 60) * 30) }, (_, i) => {
        const len = 4 + Math.floor(rnd() * 17);
        const text = Array.from({ length: len }, () => glyphs[Math.floor(rnd() * glyphs.length)]).join('');
        const r = rnd();
        return { time: (i * 60) / perMinute, text, mode: r < 0.08 ? 'top' : r < 0.14 ? 'bottom' : 'rtl', color: [0xffffff, 0xfe0302, 0xffff00, 0x00cd00][i % 4] as number } as const;
      });
      o.dispatch('load-danmaku', { comments });
    }, PER_MINUTE);
    const frames0 = await page.evaluate(async () => ((await window.otter) as OtterFixture).danmaku()?.frames ?? 0);
    const r = await measure(WINDOW_S);
    const after = await page.evaluate(async () => {
      const d = ((await window.otter) as OtterFixture).danmaku();
      return { frames: d?.frames ?? 0, renderer: d?.renderer ?? null, cost: d?.cost ?? { p50: 0, p95: 0 }, ownFrameP95: d?.ownFrameP95 ?? null };
    });
    const over = baseline.p95 > 0 ? r.p95 / baseline.p95 - 1 : 0;
    // The Worker presents on its own: its frames count too (the page's rAF does not show them late).
    const own = after.ownFrameP95;
    const ownOver = own === null || baseline.p95 <= 0 ? 0 : own / baseline.p95 - 1;
    const relative = after.cost.p95 < MAX_COST_P95_MS && over <= MAX_RAF_P95_OVER_BASELINE && ownOver <= MAX_RAF_P95_OVER_BASELINE;

    const bench = process.env['OTTER_BENCH'] === '1';
    mkdirSync('docs/reports/m5', { recursive: true });
    if (bench) {
      const out = { perMinute: PER_MINUTE, windowS: WINDOW_S, ...r, drawn: after.frames - frames0, renderer: after.renderer, cost: after.cost, workerFrameP95: own, baseline: { windowS: BASELINE_S, ...baseline }, rafP95OverBaseline: over };
      writeFileSync(`docs/reports/m5/bench-danmaku-${renderer}-${test.info().project.name}.json`, `${JSON.stringify(out, null, 2)}\n`);
    }
    const pct = `${over >= 0 ? '+' : ''}${(over * 100).toFixed(0)} %`;
    ciNotice(
      `danmaku bench ${renderer}: ${PER_MINUTE}/min, ${r.onStage} on stage (peak ${r.peakOnStage}); rAF p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms (baseline ${baseline.p95.toFixed(1)} ms, ${pct}), max ${r.max.toFixed(1)} ms; main-thread cost per frame p50 ${after.cost.p50.toFixed(2)} / p95 ${after.cost.p95.toFixed(2)} ms;${own === null ? '' : ` Worker frame interval p95 ${own.toFixed(1)} ms;`} ${r.gapsOver50} gaps > 50 ms (baseline ${baseline.gapsOver50}); long tasks ${r.longTasks ?? 'n/a'}; relative criterion (cost p95 < ${MAX_COST_P95_MS} ms, rAF p95 ≤ baseline +${MAX_RAF_P95_OVER_BASELINE * 100} %): ${relative ? 'met' : 'NOT met'}`,
    );
    expect(after.renderer).toBe(renderer);
    if (!bench) return;
    expect(r.p95).toBeLessThan(20);
    if (own !== null) expect(own).toBeLessThan(20);
    if (r.longTasks !== null) expect(r.longTasks).toBe(0);
    else expect(r.gapsOver50).toBe(0);
  });
}
