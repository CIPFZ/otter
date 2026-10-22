// Background mode (SPEC §15 后台, ADR-008 §8) on the WebCodecs path: with the page hidden no video
// is decoded or drawn (GPU rendering stops), the clock keeps running; back in view the picture
// is at the clock at once. Headless browsers do not hide a page behind another tab, so
// visibility is emulated: a controllable document.visibilityState and a real visibilitychange.
// (MMS startstreaming / endstreaming for the own MSE engines: unit tests, engine-pipeline.)

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const FPS = 30;

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

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    (window as { __otterHidden?: boolean }).__otterHidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

const state = (page: Page) =>
  page.evaluate(async () => {
    const s = ((await window.otter) as OtterFixture).state();
    return { t: s.currentTime, paused: s.paused, mode: s.presentation?.mode, backend: s.backend };
  });

test('background on WebCodecs: nothing decoded or drawn while hidden, the clock runs on, the picture catches up on return', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => ((window as { __otterHidden?: boolean }).__otterHidden === true ? 'hidden' : 'visible') });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => (window as { __otterHidden?: boolean }).__otterHidden === true });
  });
  await page.goto('/player.html?idle=0');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: await o.fetchBlob('/frames/h264-video-only.mp4') }, { autoplay: true });
  });
  await expect.poll(async () => (await state(page)).t, { timeout: 30_000 }).toBeGreaterThan(1);
  expect((await state(page)).backend).toBe('webcodecs');

  await setHidden(page, true);
  await page.waitForTimeout(300);
  const before = await frameOnPlayer(page);
  const t0 = (await state(page)).t;
  await page.waitForTimeout(2000);
  // Presentation mode follows the page.
  expect((await state(page)).mode).toBe('background');
  // The picture did not change (no decoding, no drawing) ...
  expect(await frameOnPlayer(page)).toBe(before);
  // ... while the clock went on.
  const t1 = (await state(page)).t;
  expect(t1 - t0).toBeGreaterThan(1.5);

  await setHidden(page, false);
  const shownAt = Date.now();
  // Back in view: the picture jumps to the clock (past the hidden span), not on from where it stopped.
  // How long that takes is recorded for every run (ADR-011 §4: CI artifact, distribution over 20
  // main runs before a threshold is set); 15 s only catches a picture that never catches up.
  let caughtUpMs: number | null = null;
  try {
    await expect.poll(async () => frameOnPlayer(page), { timeout: 15_000, intervals: [100] }).toBeGreaterThan(before + (t1 - t0) * FPS * 0.9);
    caughtUpMs = Date.now() - shownAt;
  } finally {
    mkdirSync('test-results/background', { recursive: true });
    appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: background catch-up ${caughtUpMs === null ? 'none within 15 s' : `${caughtUpMs} ms`} (retry ${test.info().retry})\n`);
    writeFileSync(`test-results/background/catch-up-${test.info().project.name}-r${test.info().retry}.json`, JSON.stringify({ project: test.info().project.name, retry: test.info().retry, caughtUpMs, hiddenS: t1 - t0, at: new Date().toISOString(), sha: process.env['GITHUB_SHA'] ?? null }));
  }
  expect((await state(page)).mode).not.toBe('background');
  expect((await state(page)).paused).toBe(false);
  // And it is the clock's frame (paused, so the comparison does not race the screenshot).
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
  await page.waitForTimeout(200);
  expect(await frameOnPlayer(page)).toBe(Math.floor((await state(page)).t * FPS + 0.0005 * FPS + 1e-6));
});
