// Danmaku performance (ADR-012, M5 acceptance): 5000 comments a minute over a playing video,
// 1280x720 player. Frame pacing from requestAnimationFrame intervals (p95 < 20 ms) and main-thread
// long tasks (PerformanceObserver 'longtask' where the browser has it; elsewhere gaps > 50 ms).
// Measured on its own machine and asserted with OTTER_BENCH=1 (run with --workers=1; writes
// docs/reports/m5/bench-danmaku-<renderer>-<project>.json). Otherwise (the suite, CI's shared
// runners with software GL, the only WebKit here) the numbers are only recorded as a notice.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const PER_MINUTE = 5000;
const WINDOW_S = 20;

for (const renderer of ['canvas2d', 'webgl', 'worker'] as const) {
  test(`danmaku ${PER_MINUTE}/min on ${renderer}: rAF p95 < 20 ms, no long tasks`, async ({ page }) => {
    test.skip(test.info().project.name.startsWith('emulated'), 'desktop browsers (phones: M7 real devices)');
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`/player.html?idle=0&danmaku=1&renderer=${renderer}`);
    await page.evaluate(async (perMinute) => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('set-muted', { muted: true });
      o.load({ src: '/frames/hls-ladder/master.m3u8' }, { autoplay: true });
      // Deterministic pseudo-random comments: lengths 4-20, mixed CJK / Latin, B站 mode mix.
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
    await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().currentTime), { timeout: 20_000 }).toBeGreaterThan(2);
    const st = await page.evaluate(async () => ((await window.otter) as OtterFixture).state().danmakuStatus);
    if (st.renderer !== renderer) {
      const why = [...st.steps].reverse().find((x) => x.candidate === renderer)?.reason ?? 'not selected';
      ciNotice(`danmaku bench ${renderer}: not available here (${why})`);
      test.skip(true, `${renderer}: ${why}`);
    }
    const r = await page.evaluate(async (windowS) => {
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
      const frames0 = o.danmaku()?.frames ?? 0;
      await new Promise<void>((resolve) => {
        let last = 0;
        const end = performance.now() + windowS * 1000;
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
        drawn: (o.danmaku()?.frames ?? 0) - frames0,
        p50: q(0.5),
        p95: q(0.95),
        max: sorted.at(-1) as number,
        gapsOver50: intervals.filter((i) => i > 50).length,
        longTasks: supportsLongTask ? longTasks.length : null,
        longestTask: longTasks.length > 0 ? Math.max(...longTasks) : 0,
        onStage: running.length > 0 ? Math.round(running.reduce((a, b) => a + b, 0) / running.length) : 0,
        peakOnStage: Math.max(0, ...running),
        renderer: o.danmaku()?.renderer ?? null,
        cost: o.danmaku()?.cost ?? { p50: 0, p95: 0 },
      };
    }, WINDOW_S);
    const bench = process.env['OTTER_BENCH'] === '1';
    mkdirSync('docs/reports/m5', { recursive: true });
    if (bench) writeFileSync(`docs/reports/m5/bench-danmaku-${renderer}-${test.info().project.name}.json`, `${JSON.stringify({ perMinute: PER_MINUTE, windowS: WINDOW_S, ...r }, null, 2)}\n`);
    ciNotice(
      `danmaku bench ${renderer}: ${PER_MINUTE}/min, ${r.onStage} on stage (peak ${r.peakOnStage}); rAF p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, max ${r.max.toFixed(1)} ms; main-thread cost per frame p50 ${r.cost.p50.toFixed(2)} / p95 ${r.cost.p95.toFixed(2)} ms; ${r.gapsOver50} gaps > 50 ms; long tasks ${r.longTasks ?? 'n/a'}`,
    );
    expect(r.renderer).toBe(renderer);
    if (!bench) return;
    expect(r.p95).toBeLessThan(20);
    if (r.longTasks !== null) expect(r.longTasks).toBe(0);
    else expect(r.gapsOver50).toBe(0);
  });
}
