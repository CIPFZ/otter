// PiP on the WebCodecs path (SPEC §15, ADR-008 §8): the picture is on a canvas, so video PiP shows
// a hidden <video> fed by canvas.captureStream(). Entering and leaving PiP must not interrupt
// playback; the PiP window's play / pause act on the player; Document PiP (the whole player in a
// window) keeps working with the canvas picture.

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const state = (page: Page) =>
  page.evaluate(async () => {
    const s = ((await window.otter) as OtterFixture).state();
    return { t: s.currentTime, paused: s.paused, backend: s.backend, mode: s.presentation?.mode, pending: s.presentation?.pending, pip: s.presentation?.capabilities.pip };
  });

async function load(page: Page, query = ''): Promise<void> {
  await page.goto(`/player.html?idle=0${query}`);
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: await o.fetchBlob('/frames/h264-video-only.mp4') }, { autoplay: true });
  });
  await expect.poll(async () => (await state(page)).t, { timeout: 30_000 }).toBeGreaterThan(0.5);
  expect((await state(page)).backend).toBe('webcodecs');
}

/** Samples the playhead every 50 ms in the page (window.samples), with the wall-clock time. */
const sample = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const w = window as unknown as { samples: { t: number; paused: boolean; at: number }[] };
    w.samples = [];
    const tick = (): void => {
      const s = o.state();
      w.samples.push({ t: s.currentTime, paused: s.paused, at: performance.now() / 1000 });
      setTimeout(tick, 50);
    };
    tick();
  });
const samples = (page: Page) => page.evaluate(() => (window as unknown as { samples: Sample[] }).samples);

type Sample = { t: number; paused: boolean; at: number };
/**
 * No pause, no jump back, no jump of more than half a second beyond the wall-clock time between
 * samples (the page's timers may be throttled while a PiP window has the focus: Android emulation
 * samples every ~0.4 s with Document PiP open).
 */
const smooth = (list: Sample[]): boolean =>
  list.every((s, i) => {
    const prev = list[i - 1];
    return !s.paused && (prev === undefined || (s.t >= prev.t && s.t - prev.t < s.at - prev.at + 0.5));
  });

test('video PiP of the WebCodecs canvas: enter and leave without interrupting playback', async ({ page, browserName }) => {
  test.setTimeout(60_000);
  await load(page);
  if ((await state(page)).pip === false) {
    ciNotice('no video PiP here: canvas PiP not testable');
    return;
  }
  // The stream video is prepared while the canvas shows the picture.
  await expect.poll(() => page.evaluate(() => (document.querySelector('video[data-otter-pip]') as HTMLVideoElement | null)?.readyState ?? 0), { timeout: 10_000 }).toBeGreaterThan(0);
  await sample(page);
  await page.addStyleTag({ content: 'otter-pip-button { display: inline-block !important; }' });
  await page.locator('otter-pip-button').getByRole('button').click();
  // Settled: in PiP, or the request is over (refused or rolled back).
  await expect.poll(async () => ((s) => (s.mode === 'pip' ? 'pip' : s.pending == null ? 'settled' : 'pending'))(await state(page)), { timeout: 8000 }).not.toBe('pending');
  if ((await state(page)).mode !== 'pip') {
    // Headless WebKit may refuse to open a PiP window (rolled back with a reason).
    const denied = await page.evaluate(async () => ((await window.otter) as OtterFixture).events.filter((e) => e.type === 'presentation-denied').map((e) => e.payload));
    expect(browserName, `PiP rolled back: ${JSON.stringify(denied)}`).toBe('webkit');
    ciNotice('canvas PiP refused by the browser; rolled back to inline');
    return;
  }
  // The PiP window shows the canvas stream: its video gets new frames while we play.
  const frames = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const v = document.pictureInPictureElement as HTMLVideoElement;
        let n = 0;
        const count = (): void => {
          n++;
          v.requestVideoFrameCallback(count);
        };
        v.requestVideoFrameCallback(count);
        setTimeout(() => resolve(n), 1500);
      }),
  );
  expect(await page.evaluate(() => (document.pictureInPictureElement as HTMLElement | null)?.dataset['otterPip'] !== undefined)).toBe(true);
  expect(frames).toBeGreaterThan(10);
  // Play / pause in the PiP window act on the player.
  await page.evaluate(() => (document.pictureInPictureElement as HTMLVideoElement).pause());
  await expect.poll(async () => (await state(page)).paused).toBe(true);
  await page.evaluate(() => (document.pictureInPictureElement as HTMLVideoElement).play());
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  await sample(page);
  await page.waitForTimeout(800);
  await page.evaluate(() => document.exitPictureInPicture());
  await expect.poll(async () => (await state(page)).mode).toBe('inline');
  await page.waitForTimeout(800);
  // Through the way out: smooth.
  expect(smooth(await samples(page))).toBe(true);
  expect((await state(page)).paused).toBe(false);
  ciNotice(`canvas PiP: ${frames} frames in 1.5 s in the PiP window, playback uninterrupted`);
});

test('Document PiP still works with the WebCodecs canvas picture', async ({ page }) => {
  test.setTimeout(60_000);
  await load(page, '&pip=document');
  const caps = await page.evaluate(async () => ((await window.otter) as OtterFixture).state().presentation?.capabilities.docpip);
  if (caps === false) {
    ciNotice('no Document PiP here');
    return;
  }
  await sample(page);
  const pip = page.locator('otter-pip-button').getByRole('button');
  if (await pip.isVisible()) await pip.click();
  else await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-pip', {}));
  await expect.poll(async () => (await state(page)).mode).toBe('docpip');
  await page.waitForTimeout(1500);
  expect(smooth(await samples(page))).toBe(true);
  // The canvas went with the player into the PiP window.
  expect(await page.evaluate(() => document.querySelector('[data-otter-frames]'))).toBeNull();
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('exit-presentation', {}));
  await expect.poll(async () => (await state(page)).mode).toBe('inline');
  await expect.poll(() => page.evaluate(() => document.querySelector('[data-otter-frames]') !== null)).toBe(true);
  expect((await state(page)).paused).toBe(false);
});
