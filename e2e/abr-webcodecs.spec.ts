// ABR on the WebCodecs path (ADR-008 §5): HLS through format-hls -> mediabunny -> WebCodecs, with
// the pipeline's rule stack choosing among the variants and switches made at a keyframe of the
// new rendition (no gap, no rebuffer). frames/hls-ladder: 30 s, 640x360 (~600 kbps) and 320x180
// (~150 kbps), keyframes aligned every 60 frames, every frame numbered in the picture.

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const FPS = 30;
const covering = (t: number): number => Math.floor(t * FPS + 0.0005 * FPS + 1e-6);

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const state = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const s = o.state();
    return {
      status: s.status,
      backend: s.backend,
      currentTime: s.currentTime,
      paused: s.paused,
      waiting: s.waiting,
      active: s.activeQuality,
      height: s.videoHeight,
      tracks: s.tracks.video.map((v) => ({ id: v.id, height: v.height ?? 0 })),
      switches: o.events.filter((e) => e.type === 'quality-switch').map((e) => e.payload as { from: string; to: string; mode: string; reason: string }),
      rebuffers: o.events.filter((e) => e.type === 'rebuffer').length,
      bandwidth: o.events.filter((e) => e.type === 'bandwidth').length,
    };
  });

async function frameOnPlayer(page: Page): Promise<number> {
  const style = await page.addStyleTag({ content: '[data-otter-top], [data-otter-controls], [data-otter-center] { visibility: hidden !important; }' });
  const png = (await page.locator('[data-otter-frames]').screenshot({ animations: 'disabled' })).toString('base64');
  await style.evaluate((el) => (el as Element).remove());
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    let bits = 0;
    for (let i = 0; i < 10; i++) {
      const d = ctx.getImageData(Math.floor(((i * 48 + 24) / 640) * img.width), Math.floor((24 / 360) * img.height), 1, 1).data;
      if ((d[0] as number) + (d[1] as number) + (d[2] as number) > 384) bits |= 1 << i;
    }
    return bits;
  }, png);
}

async function start(page: Page): Promise<void> {
  await page.goto('/player.html?prefer=webcodecs&idle=0');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/frames/hls-ladder/master.m3u8' }, { autoplay: true });
  });
  await expect.poll(async () => (await state(page)).status, { timeout: 30_000 }).toBe('ready');
  expect((await state(page)).backend).toBe('webcodecs');
}

test('manual quality switch on WebCodecs: at the next keyframe, no rebuffer, picture continues', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  let s = await state(page);
  expect(s.tracks.map((t) => t.height).sort((a, b) => a - b)).toEqual([180, 360]);
  const target = s.tracks.find((t) => t.id !== s.active) as { id: string; height: number };
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 10_000 }).toBeGreaterThan(1);
  // Rebuffers of the switch only (a loaded machine may stall once at the start).
  const { currentTime: t0, rebuffers: r0 } = await state(page);
  await page.evaluate(async (id) => ((await window.otter) as OtterFixture).dispatch('select-quality', { id }), target.id);
  // A switch lands within a keyframe interval (2 s) plus what is decoded ahead.
  await expect.poll(async () => (await state(page)).height, { timeout: 8_000 }).toBe(target.height);
  s = await state(page);
  expect(s.active).toBe(target.id);
  expect(s.switches.at(-1)).toMatchObject({ to: target.id, mode: 'manual' });
  expect(s.rebuffers).toBe(r0);
  expect(s.currentTime).toBeGreaterThan(t0);
  // The new rendition's pictures are the right frames.
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
  await page.waitForTimeout(150);
  expect(await frameOnPlayer(page)).toBe(covering((await state(page)).currentTime));
});

test('automatic quality on WebCodecs: high on a fast network, down when the high rendition slows', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  const high = (await state(page)).tracks.find((t) => t.height === 360)?.id as string;
  const low = (await state(page)).tracks.find((t) => t.height === 180)?.id as string;
  // Fast local network: ABR goes (or stays) up.
  await expect.poll(async () => (await state(page)).active, { timeout: 30_000 }).toBe(high);
  await expect.poll(async () => (await state(page)).bandwidth, { timeout: 15_000 }).toBeGreaterThan(0);
  // The high rendition's segments now take 3 s for 2 s of media: ABR has to come down.
  await page.route('**/frames/hls-ladder/v0_*.m4s', async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  await expect.poll(async () => (await state(page)).active, { timeout: 45_000 }).toBe(low);
  const s = await state(page);
  const down = s.switches.filter((x) => x.to === low && x.mode === 'auto');
  expect(down.length).toBeGreaterThan(0);
  expect(s.backend).toBe('webcodecs');
  ciNotice(`WebCodecs ABR: ${s.switches.map((x) => `${x.from}->${x.to} (${x.mode})`).join(', ')}; last reason: ${down.at(-1)?.reason}`);
});
