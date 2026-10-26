// Watermark (SPEC §13.3, ADR-012 §7): a static corner mark and a moving anti-recording mark over
// the picture, following fullscreen, Document PiP and video PiP (where the <video> alone would go:
// a composite canvas of picture + mark feeds the PiP window). The fixture's test mark is green
// (#00ff00) text 'OTTER-WM'; checked in screenshots and in the PiP stream's frames.

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

async function start(page: Page, query: string, autoplay = false): Promise<void> {
  await page.goto(`/player.html?idle=0${query}`);
  await page.evaluate(async (play) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/frames/hls-ladder/master.m3u8' }, { autoplay: play });
  }, autoplay);
  await expect.poll(async () => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
}

/** Pure-green pixels in a screenshot of `selector`, or of the whole page (the picture's own greens are darker). */
async function greenIn(page: Page, selector?: string): Promise<number> {
  const png = (await (selector === undefined ? page : page.locator(selector).first()).screenshot({ animations: 'disabled' })).toString('base64');
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if ((d[i + 1] as number) > 235 && (d[i] as number) < 40 && (d[i + 2] as number) < 40) n++;
    return n;
  }, png);
}

/** The mark's box relative to the picture (fractions), from the DOM. */
const box = (page: Page) =>
  page.evaluate(() => {
    const mark = document.querySelector('[data-otter-watermark]') as HTMLElement;
    const video = document.querySelector('#player video, video') as HTMLVideoElement;
    const m = mark.getBoundingClientRect();
    const v = video.getBoundingClientRect();
    // The picture is letterboxed 16:9 in the video box.
    const h = Math.min(v.height, (v.width * 9) / 16);
    const w = (h * 16) / 9;
    const px = v.x + (v.width - w) / 2;
    const py = v.y + (v.height - h) / 2;
    return { x: (m.x - px) / w, y: (m.y - py) / h, r: (m.right - px) / w, b: (m.bottom - py) / h };
  });

test('static mark: in the picture\'s top-right corner, drawn', async ({ page }) => {
  await start(page, '&watermark=static');
  const b = await box(page);
  expect(b.x).toBeGreaterThan(0.5);
  expect(b.r).toBeLessThanOrEqual(1);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.b).toBeLessThan(0.3);
  expect(await greenIn(page, '#player')).toBeGreaterThan(100);
});

test('moving mark: moves inside the picture, comes back when removed or hidden', async ({ page }) => {
  await start(page, '&watermark=moving&wminterval=1', true);
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    const b = await box(page);
    for (const v of [b.x, b.y, b.r, b.b]) {
      expect(v).toBeGreaterThanOrEqual(-0.001);
      expect(v).toBeLessThanOrEqual(1.001);
    }
    seen.push(`${b.x.toFixed(2)},${b.y.toFixed(2)}`);
    await page.waitForTimeout(1100);
  }
  expect(new Set(seen).size).toBeGreaterThan(2);
  expect(await greenIn(page, '#player')).toBeGreaterThan(100);
  // A page script or an extension takes it away: it is back at once.
  await page.evaluate(() => document.querySelector('[data-otter-watermark]')?.remove());
  await expect(page.locator('[data-otter-watermark]')).toHaveCount(1);
  await page.evaluate(() => ((document.querySelector('[data-otter-watermark]') as HTMLElement).style.display = 'none'));
  await expect(page.locator('[data-otter-watermark]')).toBeVisible();
  await page.evaluate(() => ((document.querySelector('[data-otter-watermark]') as HTMLElement).style.opacity = '0'));
  await expect(page.locator('[data-otter-watermark]')).toHaveCSS('opacity', '1');
  ciNotice(`watermark moving: places ${seen.join(' | ')}; removed / display none / opacity 0 -> restored`);
});

test('fullscreen: the mark is inside the fullscreen player and on screen', async ({ page }) => {
  await start(page, '&watermark=static');
  await page.locator('otter-fullscreen-button').getByRole('button').click();
  const mode = await expect
    .poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().presentation.mode), { timeout: 5000 })
    .toBe('fullscreen')
    .then(() => 'fullscreen')
    .catch(() => 'not entered');
  if (mode !== 'fullscreen') {
    ciNotice('watermark fullscreen: fullscreen not entered here');
    test.skip(true, 'no fullscreen');
  }
  const inside = await page.evaluate(() => {
    const fs = document.fullscreenElement ?? document.getElementById('player');
    return fs?.contains(document.querySelector('[data-otter-watermark]')) === true;
  });
  expect(inside).toBe(true);
  await page.waitForTimeout(300);
  const b = await box(page);
  expect(b.x).toBeGreaterThan(0.5);
  expect(b.r).toBeLessThanOrEqual(1);
  // The page, not an element: the fullscreen element is on top of everything.
  expect(await greenIn(page)).toBeGreaterThan(100);
});

test('Document PiP carries the mark; video PiP shows the picture with it', async ({ page }) => {
  test.setTimeout(60_000);
  // Video PiP: the PiP window's video is the composite stream (picture + mark).
  await start(page, '&watermark=static', true);
  await page.addStyleTag({ content: 'otter-pip-button { display: inline-block !important; }' });
  const caps = await page.evaluate(async () => ((await window.otter) as OtterFixture).state().presentation.capabilities);
  if (caps.pip !== false) {
    await page.locator('otter-pip-button').getByRole('button').click();
    const entered = await expect
      .poll(async () => page.evaluate(() => (document.pictureInPictureElement as HTMLVideoElement | null)?.dataset['otterPip'] !== undefined), { timeout: 5000 })
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    if (entered) {
      await page.waitForTimeout(500);
      const greens = await page.evaluate(() => {
        const v = document.pictureInPictureElement as HTMLVideoElement;
        const c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
        const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(v, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if ((d[i + 1] as number) > 235 && (d[i] as number) < 40 && (d[i + 2] as number) < 40) n++;
        return n;
      });
      expect(greens).toBeGreaterThan(50);
      ciNotice(`watermark video PiP: composite stream, ${greens} mark pixels in the PiP frame`);
      await page.evaluate(() => document.exitPictureInPicture());
    } else ciNotice('watermark video PiP: not entered here');
  }
  // Document PiP: the player (and its overlays) moves into the PiP window.
  await start(page, '&watermark=static&pip=document', true);
  const docpip = await page.evaluate(async () => ((await window.otter) as OtterFixture).state().presentation.capabilities.docpip);
  if (docpip === false) {
    ciNotice('watermark Document PiP: unsupported here');
    return;
  }
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-pip', {}));
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().presentation.mode)).toBe('docpip');
  const inPip = await page.evaluate(() => {
    const w = (window as unknown as { documentPictureInPicture: { window: Window | null } }).documentPictureInPicture.window;
    const mark = w?.document.querySelector('[data-otter-watermark]') as HTMLElement | null;
    return mark === null || mark === undefined ? null : { shown: mark.getBoundingClientRect().width > 0, text: mark.textContent };
  });
  expect(inPip).toEqual({ shown: true, text: 'OTTER-WM' });
  ciNotice('watermark Document PiP: the mark moved with the player');
  // Closed before the context goes (Firefox's context close fails with a PiP window open).
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-pip', {}));
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().presentation.mode)).not.toBe('docpip');
});
