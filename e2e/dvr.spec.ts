// DVR time bar (ADR-011 §2): on a live stream the time slider spans the seekable window, the
// live indicator shows how far behind the live edge the picture is ("−6.0 s", from the engine's
// corrected edge), dragging seeks inside the window, and Back to live returns to the target.
// The shown distance is checked against the wall latency read from the frame number painted in
// the picture (e2e/live-hls.ts: the 30 s numbered ladder looped, /live-hls/clock the live point).

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

/**
 * The indicator's "−6.0 s" as seconds, with the wall latency of the same moment: the frame
 * number painted in the picture (hls-ladder: 10 bits across the top), read from the video in the
 * page right where the indicator is read, against the source's live point. Not a screenshot:
 * on WebKit a screenshot takes 0.5-0.9 s, which a playing stream adds to the wall latency.
 */
async function shownAndWall(page: Page): Promise<{ shown: number; wall: number }> {
  const { live, text, frame } = await page.evaluate(async () => {
    const video = document.querySelector('video') as HTMLVideoElement;
    const c = new OffscreenCanvas(video.videoWidth, video.videoHeight);
    const ctx = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(video, 0, 0);
    let bits = 0;
    for (let i = 0; i < 10; i++) {
      const d = ctx.getImageData(Math.floor(((i * 48 + 24) / 640) * c.width), Math.floor((24 / 360) * c.height), 1, 1).data;
      if ((d[0] as number) + (d[1] as number) + (d[2] as number) > 384) bits |= 1 << i;
    }
    const el = document.querySelector('otter-live-indicator')?.shadowRoot?.querySelector('i');
    const shownText = el?.textContent ?? '';
    const clock = (await (await fetch('/live-hls/clock')).json()) as { live: number };
    return { live: clock.live, text: shownText, frame: bits };
  });
  return { shown: Number(text.replace(/[−\s]|s$/g, '')), wall: (((live - frame / 30) % 30) + 30) % 30 };
}

/** One line for the CI run page (the workflow turns test-results/ci-notices.txt into notices). */
const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const state = (page: Page) =>
  page.evaluate(async () => {
    const s = ((await window.otter) as OtterFixture).state();
    const slider = document.querySelector('otter-time-slider')?.shadowRoot?.querySelector('input') as HTMLInputElement;
    return { t: s.currentTime, latency: s.latency, paused: s.paused, window: [s.seekableStart, s.seekableEnd], slider: { disabled: slider.disabled, min: Number(slider.min), max: Number(slider.max), value: Number(slider.value), text: slider.getAttribute('aria-valuetext') } };
  });

test('live DVR: window on the slider, distance behind live checked against the picture, drag and back to live', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/player.html?idle=0');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/live-hls/master.m3u8', live: true }, { autoplay: true });
  });
  await expect.poll(async () => (await state(page)).slider.disabled, { timeout: 20_000 }).toBe(false);
  await page.waitForTimeout(3000);
  let s = await state(page);
  // The slider spans the seekable window (six 2 s segments).
  expect(s.slider.min).toBeCloseTo(s.window[0] as number, 1);
  expect(s.slider.max).toBeCloseTo(s.window[1] as number, 1);
  expect(s.slider.max - s.slider.min).toBeGreaterThan(9);
  expect(s.slider.text).toMatch(/^Behind live \d/);

  // At the target (~6 s, HOLD-BACK): the shown distance is the wall latency (±0.5 s).
  const checks: string[] = [];
  for (let k = 0; k < 2; k++) {
    const { shown, wall } = await shownAndWall(page);
    checks.push(`${shown} / ${wall.toFixed(2)}`);
    expect(Math.abs(shown - wall), `shown ${shown} s, wall ${wall.toFixed(2)} s`).toBeLessThan(0.5);
    await page.waitForTimeout(1000);
  }

  // Drag to the start of the window: about window-length behind, still checked against the picture.
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
  const slider = page.locator('otter-time-slider').locator('input');
  // WebKit fires `seeked` before a paused element shows (and drawImage reads) the new frame
  // (RESEARCH §1): wait for the presented frame, as the surfaces fixture does.
  await page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement;
    (window as unknown as { presented: Promise<void> }).presented = new Promise<void>((resolve) => {
      v.addEventListener(
        'seeked',
        () => {
          const shown = typeof v.requestVideoFrameCallback === 'function' ? new Promise<void>((r) => v.requestVideoFrameCallback(() => r())) : Promise.resolve();
          void Promise.race([shown, new Promise((r) => setTimeout(r, 1000))]).then(() => resolve());
        },
        { once: true },
      );
    });
  });
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = String(Number(el.min) + 1);
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  });
  await expect.poll(async () => (await state(page)).latency as number, { timeout: 10_000 }).toBeGreaterThan(9);
  // At most 2 s: a WebKit run once never fired `seeked` for this seek (it showed the frame).
  await page.evaluate(() => Promise.race([(window as unknown as { presented: Promise<void> }).presented, new Promise((r) => setTimeout(r, 2000))]));
  await page.waitForTimeout(300);
  {
    // WebKit may still draw the frame from before the seek for a moment (even after its
    // presentation callback): read again until the picture is the sought one, up to 5 s.
    let { shown, wall } = await shownAndWall(page);
    for (let i = 0; i < 10 && Math.abs(shown - wall) >= 0.5; i++) {
      await page.waitForTimeout(500);
      ({ shown, wall } = await shownAndWall(page));
    }
    checks.push(`after the drag ${shown} / ${wall.toFixed(2)}`);
    ciNotice(`dvr: shown / wall latency (s): ${checks.join(', ')}`);
    expect(Math.abs(shown - wall), `after the drag: shown ${shown} s, wall ${wall.toFixed(2)} s`).toBeLessThan(0.5);
  }
  // Playing from there keeps the position (no chase back to the target), at normal speed.
  const dragged = (await state(page)).latency as number;
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('play', undefined));
  await page.waitForTimeout(3000);
  s = await state(page);
  expect(s.paused).toBe(false);
  expect(Math.abs((s.latency as number) - dragged), `latency ${dragged} -> ${s.latency} while playing`).toBeLessThan(1);
  expect(await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).playbackRate)).toBe(1);
  // Behind the target by more than 3 s: Back to live, one click.
  const back = page.locator('otter-live-indicator').getByRole('button');
  await expect(back).toBeVisible();
  await back.click();
  await expect.poll(async () => (await state(page)).latency as number, { timeout: 10_000 }).toBeLessThan(7.5);
  s = await state(page);
  expect(s.paused).toBe(false);
});

test('FLV live: the window is what is buffered (one long stream cannot fetch the past again)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/player.html?idle=0');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/live/stream.flv', live: true }, { autoplay: true });
  });
  await expect.poll(async () => (await state(page)).slider.disabled, { timeout: 20_000 }).toBe(false);
  const r = await page.evaluate(async () => {
    const v = document.querySelector('video') as HTMLVideoElement;
    const s = ((await window.otter) as OtterFixture).state();
    return { buffered: [v.buffered.start(0), v.buffered.end(v.buffered.length - 1)], window: [s.seekableStart, s.seekableEnd] };
  });
  expect(r.window[0]).toBeCloseTo(r.buffered[0] as number, 0);
  expect(r.window[1] as number).toBeLessThanOrEqual((r.buffered[1] as number) + 0.5);
});
