// Seek-preview thumbnails (ADR-007 §7): hovering the progress bar shows a picture in the preview
// card, from a WebVTT sprite track or from the HLS I-frame playlist (hls.js I-frame player).

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

async function open(page: Page, source: object): Promise<void> {
  await page.goto('/player.html?idle=0');
  await page.evaluate(async (src) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load(src as Parameters<OtterFixture['load']>[0], { autoplay: true });
  }, source);
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().currentTime), { timeout: 20_000 }).toBeGreaterThan(0.3);
}

/** Hovers the progress bar at `fraction` of its width (8 s sample: 0.5 -> 4 s). */
async function hover(page: Page, fraction: number): Promise<void> {
  const box = await page.locator('otter-time-slider').boundingBox();
  if (box === null) throw new Error('no progress bar');
  await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2, { steps: 4 });
}

const card = (page: Page) => page.locator('otter-time-slider').locator('.card');

test.describe('preview card thumbnails', () => {
  test.skip(({ isMobile }) => isMobile, 'hover preview is a pointer feature; touch shows the swipe preview');

  test('WebVTT sprite: the tile for the hovered time', async ({ page }) => {
    await open(page, { src: '/hls-fmp4/master.m3u8', thumbnails: { src: '/thumbs/thumbs.vtt' } });
    // 0.4 of 8 s = 3.2 s: the 2-4 s tile, second in the 4x1 sheet.
    await hover(page, 0.4);
    await expect(card(page)).toHaveAttribute('data-thumb', '');
    const tile = card(page).locator('.thumb > i');
    await expect(tile).toBeVisible();
    await expect.poll(() => tile.evaluate((el) => getComputedStyle(el).backgroundPosition)).toBe('-160px 0px');
    expect(await tile.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('/thumbs/sprite.jpg');
    // Next tile further right.
    await hover(page, 0.8);
    await expect.poll(() => tile.evaluate((el) => getComputedStyle(el).backgroundPosition)).toBe('-480px 0px');
  });

  test('HLS I-frame playlist: a decoded frame on a canvas', async ({ page }) => {
    await open(page, { src: '/hls-iframes/master.m3u8' });
    await hover(page, 0.6);
    await expect(card(page)).toHaveAttribute('data-thumb', '', { timeout: 10_000 });
    const canvas = card(page).locator('.thumb > canvas');
    await expect(canvas).toBeVisible();
    // Not blank: testsrc2 is colourful everywhere.
    await expect
      .poll(() =>
        canvas.evaluate((c: HTMLCanvasElement) => {
          const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
          if (d === undefined || c.width === 0) return 0;
          let lit = 0;
          for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0) > 60) lit++;
          return lit / (d.length / 4);
        }),
      )
      .toBeGreaterThan(0.2);
    expect(await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([320, 180]);
  });

  test('no thumbnail source: the card shows the time only', async ({ page }) => {
    await open(page, { src: '/hls-fmp4/master.m3u8' });
    await hover(page, 0.5);
    await expect(card(page)).toHaveAttribute('data-show', '');
    await page.waitForTimeout(300);
    await expect(card(page)).not.toHaveAttribute('data-thumb');
  });
});
