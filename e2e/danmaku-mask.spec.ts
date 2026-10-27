// Danmaku masks (ADR-012 §6): comments are erased where the mask says the subject is, and the
// mask is the one of the picture on screen (≤ 1 frame apart). Checked from screenshots: the
// numbered ladder (frames/hls-ladder: the frame number in 10 bits across the top) under a band
// mask whose band moves one thirtieth of the width per frame (danmaku/mask-band.{json,webm}: band
// k = frame mod 30), with full-width green comments along the bottom. In each screenshot the
// frame number and the band position must agree: exactly while paused, within one frame while
// playing. SVG frames on every renderer; WebM alpha where the browser decodes VP9 alpha.
// @solo: frame timing needs the machine to itself (a software compositor shared with the parallel
// suite misses frames); run alone, one worker (CI has a step for it).

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const BANDS = 30;

/** Frame number (top bits) and band index (bottom comments, where green is missing) in one screenshot. */
async function readShot(page: Page): Promise<{ frame: number; band: number | null; runs: string }> {
  // The player's video (the WebM mask is a hidden <video> too).
  const png = (await page.locator('video').first().screenshot({ animations: 'disabled' })).toString('base64');
  return page.evaluate(
    async ([b64, bands]) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      const h = Math.min(img.height, (img.width * 9) / 16);
      const w = (h * 16) / 9;
      const x0 = (img.width - w) / 2;
      const y0 = (img.height - h) / 2;
      let frame = 0;
      for (let i = 0; i < 10; i++) {
        const d = ctx.getImageData(Math.floor(x0 + ((i * 48 + 24) / 640) * w), Math.floor(y0 + (24 / 360) * h), 1, 1).data;
        if ((d[0] as number) + (d[1] as number) + (d[2] as number) > 384) frame |= 1 << i;
      }
      // Bottom comment row: a few rows above the picture's bottom edge; a column is "comment" if
      // any of them is green.
      const rows = [0.04, 0.05, 0.06].map((f) => ctx.getImageData(Math.floor(x0), Math.floor(y0 + h * (1 - f)), Math.floor(w), 1).data);
      // The comments are #00ff00; the picture's own green bar is darker (#00cd00).
      const green = (x: number): boolean => rows.some((r) => (r[x * 4 + 1] as number) > 235 && (r[x * 4] as number) < 40 && (r[x * 4 + 2] as number) < 40);
      const runs: [number, number][] = [];
      let start = -1;
      for (let x = 0; x <= Math.floor(w); x++) {
        const gap = x < Math.floor(w) && !green(x);
        if (gap && start < 0) start = x;
        if (!gap && start >= 0) {
          runs.push([start, x]);
          start = -1;
        }
      }
      const bandW = w / bands;
      const band = runs.filter(([a, b]) => b - a >= bandW * 0.6 && b - a <= bandW * 1.6);
      const centre = band.length === 1 ? ((band[0] as [number, number])[0] + (band[0] as [number, number])[1]) / 2 : undefined;
      return { frame, band: centre === undefined ? null : Math.floor(centre / bandW), runs: runs.filter(([a, b]) => b - a > 3).map(([a, b]) => `${a}-${b}`).join(',') };
    },
    [png, BANDS] as const,
  );
}

const offBy = (a: { frame: number; band: number }): number => {
  const d = (((a.band - (a.frame % BANDS)) % BANDS) + BANDS) % BANDS;
  return Math.min(d, BANDS - d);
};

for (const kind of ['svg', 'webm'] as const) {
  for (const renderer of ['canvas2d', 'webgl', 'worker'] as const) {
    test(`${kind} mask on ${renderer}: the band erases comments at the picture's own frame (paused exact, playing ≤ 1 frame) @solo`, async ({ page }) => {
      test.setTimeout(90_000);
      // Desktop: a 960 px player. Phones keep their own viewport (a 1280 px-wide Pixel 7 would be a
      // 3360 px software-composited page, late on every frame).
      if (!test.info().project.name.startsWith('emulated')) await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto(`/player.html?idle=0&danmaku=1&renderer=${renderer}`);
      await page.addStyleTag({ content: '[data-otter-top], [data-otter-controls], [data-otter-center], [data-otter-live] { visibility: hidden !important; }' });
      await page.evaluate(async (k) => {
        const o = (await window.otter) as OtterFixture;
        o.dispatch('set-muted', { muted: true });
        o.load({ src: '/frames/hls-ladder/master.m3u8' }, { autoplay: false });
        // Full-width green blocks along the bottom, always one in the lowest row.
        // 80 blocks: wider than the picture with any font (CI's Linux font draws █ narrower).
        o.dispatch('load-danmaku', { comments: Array.from({ length: 64 }, (_, i) => ({ time: i * 0.5, text: '█'.repeat(80), mode: 'bottom' as const, color: 0x00ff00 })) });
        o.dispatch('load-danmaku-mask', k === 'svg' ? { kind: 'svg', url: '/danmaku/mask-band.json' } : { kind: 'webm', url: '/danmaku/mask-band.webm', fps: 30 });
      }, kind);
      await expect.poll(async () => (await page.evaluate(async () => ((await window.otter) as OtterFixture).state().danmakuStatus.mask)) ?? '', { timeout: 15_000 }).toMatch(new RegExp(`^${kind}: (\\d+ frames|30 fps)$|rejected`));
      const st = await page.evaluate(async () => ((await window.otter) as OtterFixture).state().danmakuStatus);
      if (/rejected/.test(st.mask ?? '')) {
        ciNotice(`danmaku mask ${kind}: ${st.mask}`);
        test.skip(true, st.mask ?? '');
      }
      if (st.renderer !== renderer) {
        ciNotice(`danmaku mask ${kind} on ${renderer}: renderer not available (${st.steps.at(-1)?.reason})`);
        test.skip(true, `${renderer} not available`);
      }
      const inspect = () => page.evaluate(async () => ((await window.otter) as OtterFixture).danmaku());
      await expect.poll(async () => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
      // Paused, at several frames: frame number and band agree exactly.
      const paused: string[] = [];
      for (const t of [2.0, 7.3, 12.6, 20.95]) {
        await page.evaluate(async (time) => ((await window.otter) as OtterFixture).dispatch('seek', { time }), t);
        await expect.poll(async () => (await inspect())?.maskIndex ?? -1, { timeout: 10_000 }).toBe(Math.floor(t * 30 + 0.03));
        await page.waitForTimeout(150);
        const r = await readShot(page);
        if (r.band === null) await page.screenshot({ path: `test-results/mask-${test.info().project.name}-${kind}-${renderer}-${t}.png` });
        expect(r.band, `t=${t}: gaps ${r.runs}`).not.toBeNull();
        expect(offBy(r as { frame: number; band: number }), `t=${t}: frame ${r.frame}, band ${r.band}`).toBe(0);
        paused.push(`${r.frame}/${r.band}`);
      }
      // Playing: within one frame in every screenshot.
      await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('play', undefined));
      const playing: number[] = [];
      /** Band minus frame: negative, the mask is behind the picture. */
      const signed: number[] = [];
      /** Per screenshot: shot frame - currentTime frame, and (frame time without the lead - currentTime) in frames. */
      const parts: string[] = [];
      // Until 8 screenshots read a band (a slow VM drops some: a screenshot taken mid-update reads
      // no single band), at most 24 (CI WebKit Worker: 6 of 12 once, 1f68c1e).
      let shots = 0;
      for (; shots < 24 && playing.length < 8; shots++) {
        await page.waitForTimeout(250);
        const before = await page.evaluate(async () => {
          const d = ((await window.otter) as OtterFixture).danmaku();
          return { ct: (document.querySelector('video') as HTMLVideoElement).currentTime, ft: d?.frameTime ?? 0, lead: d?.lead ?? 0 };
        });
        const r = await readShot(page);
        parts.push(`${r.frame - Math.floor(before.ct * 30)}/${((before.ft - before.lead - before.ct) * 30).toFixed(1)}/${(before.lead * 30).toFixed(1)}`);
        if (r.band === null) continue;
        playing.push(offBy(r as { frame: number; band: number }));
        signed.push(((((r.band as number) - (r.frame % BANDS)) % BANDS) + BANDS + 15) % BANDS - 15);
      }
      expect(playing.length, `${playing.length} of ${shots} screenshots read a band`).toBeGreaterThanOrEqual(8);
      expect(Math.max(...playing), `band - frame ${signed.join(',')}; shot - ct / ft - ct / lead (frames) ${parts.join(' ')}`).toBeLessThanOrEqual(1);
      const d = await inspect();
      ciNotice(`danmaku mask ${kind} on ${renderer}: paused frame/band ${paused.join(' ')}; playing band - frame ${signed.join(',')} frames (${shots} shots); ${d?.maskMissing ?? 0} frames drawn before the mask frame was ready; lead ${((d?.lead ?? 0) * 1000).toFixed(0)} ms`);
    });
  }
}
