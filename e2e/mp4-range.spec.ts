// format-mp4-range (ADR-007 §4): two progressive MP4 renditions over MSE with Range requests;
// quality switches happen at a keyframe boundary without flushing, so playback never waits.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const RENDITIONS = [
  { src: '/mp4-range/360.mp4', width: 640, height: 360 },
  { src: '/mp4-range/180.mp4', width: 320, height: 180 },
];

const state = (page: Page) => page.evaluate(async () => ((await window.otter) as OtterFixture).state());

async function open(page: Page, start: string): Promise<void> {
  // A 4 s buffer goal keeps most of the 12 s clip unbuffered, so switches have something to apply to.
  await page.goto('/player.html?idle=0&ahead=4');
  await page.evaluate(async ([src, renditions]) => {
    const o = (await window.otter) as OtterFixture;
    const v = document.querySelector('video') as HTMLVideoElement;
    const w = window as unknown as { waits: number; ranges: string[] };
    w.waits = 0;
    // `waiting` after the first frame is a stall: the switch must not cause one.
    v.addEventListener('waiting', () => {
      if (v.currentTime > 0.2) w.waits++;
    });
    o.dispatch('set-muted', { muted: true });
    o.load({ src: src as string, renditions: renditions as typeof RENDITIONS }, { autoplay: true });
  }, [start, RENDITIONS] as const);
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 20_000 }).toBeGreaterThan(0.5);
}

const width = (page: Page) => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).videoWidth);
const waits = (page: Page) => page.evaluate(() => (window as unknown as { waits: number }).waits);

test.describe('mp4-range', () => {
  test('two renditions play over MSE with Range requests (moov at the end of the start file)', async ({ page }) => {
    const ranges: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/mp4-range/')) ranges.push(`${new URL(r.url()).pathname} ${r.headers()['range'] ?? 'no range'}`);
    });
    await open(page, '/mp4-range/360.mp4');
    const s = await state(page);
    expect(s).toMatchObject({ format: 'mp4-range', backend: 'mse' });
    expect(s.tracks.video.map((v) => [v.id, v.height])).toEqual([
      ['rendition-0', 360],
      ['rendition-1', 180],
    ]);
    expect(await width(page)).toBe(640);
    // Head first, then moov at the tail, then media chunks: never the whole file at once.
    expect(ranges.every((r) => / bytes=\d+-\d+$/.test(r))).toBe(true);
    expect(ranges[0]).toBe('/mp4-range/360.mp4 bytes=0-65535');
  });

  test('manual switch down and up: resolution changes at a keyframe, no waiting, playhead keeps moving', async ({ page }) => {
    await open(page, '/mp4-range/360.mp4');
    expect(await width(page)).toBe(640);
    const quality = async () => (await state(page)).activeQuality;
    // Each switch applies to what is not buffered yet, so ask for the next one as soon as the
    // previous one is applied (the 12 s clip must still have unbuffered media left).
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('select-quality', { id: 'rendition-1' }));
    await expect.poll(quality, { timeout: 10_000 }).toBe('rendition-1');
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('select-quality', { id: 'rendition-0' }));
    await expect.poll(quality, { timeout: 10_000 }).toBe('rendition-0');
    // The picture follows at the keyframe boundaries: 180p first, then 360p again.
    await expect.poll(() => width(page), { timeout: 15_000 }).toBe(320);
    const mid = (await state(page)).currentTime;
    await expect.poll(() => width(page), { timeout: 15_000 }).toBe(640);
    const s = await state(page);
    expect(s.currentTime).toBeGreaterThan(mid);
    expect(s.paused).toBe(false);
    expect(await waits(page)).toBe(0);
    expect(s.qoe.rebufferCount).toBe(0);
    expect(s.qoe.qualitySwitches).toBeGreaterThanOrEqual(2);
  });

  test('ABR switches up on its own when bandwidth allows, without waiting', async ({ page }) => {
    await open(page, '/mp4-range/180.mp4');
    await expect.poll(async () => (await state(page)).activeQuality, { timeout: 15_000 }).toBe('rendition-0');
    await expect.poll(() => width(page), { timeout: 15_000 }).toBe(640);
    const s = await state(page);
    expect(s.quality).toBe('auto');
    expect(await waits(page)).toBe(0);
    expect(s.qoe.rebufferCount).toBe(0);
  });

  test('seeking outside the buffer reads from the keyframe before the target', async ({ page }) => {
    await open(page, '/mp4-range/180.mp4');
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('seek', { time: 9.5 }));
    await expect.poll(async () => (await state(page)).currentTime, { timeout: 10_000 }).toBeGreaterThan(9.6);
  });
});
