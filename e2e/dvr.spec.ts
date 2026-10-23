// DVR time bar (ADR-011 §2): on a live stream the time slider spans the seekable window, the
// live indicator shows how far behind the live edge the picture is ("−6.0 s", from the engine's
// corrected edge), dragging seeks inside the window, and Back to live returns to the target.
// The shown distance is checked against the wall latency read from the frame number painted in
// the picture (e2e/live-hls.ts: the 30 s numbered ladder looped, /live-hls/clock the live point).

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

/** Frame number in the picture (hls-ladder: 10 bits across the top). */
async function frameOnPlayer(page: Page): Promise<number> {
  const style = await page.addStyleTag({ content: '[data-otter-top], [data-otter-controls], [data-otter-center] { visibility: hidden !important; }' });
  const png = (await page.locator('video').screenshot({ animations: 'disabled' })).toString('base64');
  await style.evaluate((el) => (el as Element).remove());
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
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

/** The indicator's "−6.0 s" as seconds, read with the paused picture's wall latency. */
async function shownAndWall(page: Page): Promise<{ shown: number; wall: number }> {
  // Paused: the picture, the display and the clock agree on one moment (the live point moves on;
  // the clock is read right after the screenshot, ~0.1 s).
  const frame = await frameOnPlayer(page);
  const { live, text } = await page.evaluate(async () => {
    const clock = (await (await fetch('/live-hls/clock')).json()) as { live: number };
    const el = document.querySelector('otter-live-indicator')?.shadowRoot?.querySelector('i');
    return { live: clock.live, text: el?.textContent ?? '' };
  });
  return { shown: Number(text.replace(/[−\s]|s$/g, '')), wall: (((live - frame / 30) % 30) + 30) % 30 };
}

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
  for (let k = 0; k < 2; k++) {
    const { shown, wall } = await shownAndWall(page);
    expect(Math.abs(shown - wall), `shown ${shown} s, wall ${wall.toFixed(2)} s`).toBeLessThan(0.5);
    await page.waitForTimeout(1000);
  }

  // Drag to the start of the window: about window-length behind, still checked against the picture.
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
  const slider = page.locator('otter-time-slider').locator('input');
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = String(Number(el.min) + 1);
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  });
  await expect.poll(async () => (await state(page)).latency as number, { timeout: 10_000 }).toBeGreaterThan(9);
  await page.waitForTimeout(500);
  {
    const { shown, wall } = await shownAndWall(page);
    expect(Math.abs(shown - wall), `after the drag: shown ${shown} s, wall ${wall.toFixed(2)} s`).toBeLessThan(0.5);
  }
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
