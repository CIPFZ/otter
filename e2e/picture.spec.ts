// Picture controls in the player shell (SPEC §12 电子放大, ADR-008 §6): Ctrl+wheel and two-finger
// pinch zoom at the pointer, a drag pans the zoomed picture, the settings menu's Picture page sets
// the filters; the same on the <video> path (mp4-range) and the WebCodecs canvas (format-file).
// Checked from the picture: the frames/*.mp4 clips number every frame in ten 48 px blocks across
// the top-left, so a zoom on the top-left corner makes those blocks proportionally bigger.

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const PATHS = [
  // <video> (mp4-range engine on native / MSE): the VideoSurface.
  { name: 'video', src: '/frames/h264-video-only.mp4', blob: false, picture: 'video' },
  // A local file: format-file on WebCodecs, the canvas FrameSurface.
  { name: 'webcodecs', src: '/frames/h264-video-only.mp4', blob: true, picture: '[data-otter-frames]' },
] as const;

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

/**
 * What the screen shows, for failure notices: the frame number in the picture's top-left bits
 * (ten 48 px blocks of the 640 px frame, letterboxed in the player), the brightest pixel of the
 * row the block width is read from, and the element's state.
 */
async function screenState(page: Page): Promise<string> {
  const png = (await page.locator('#player').screenshot({ animations: 'disabled' })).toString('base64');
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
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
    const row = ctx.getImageData(0, Math.round(img.height * 0.03), img.width, 1).data;
    let max = 0;
    for (let x = 0; x < img.width; x++) max = Math.max(max, (row[x * 4] as number) + (row[x * 4 + 1] as number) + (row[x * 4 + 2] as number));
    const v = document.querySelector('video') as HTMLVideoElement;
    return `frame ${frame}, row max ${max}/765, ct ${v.currentTime.toFixed(3)}, rs ${v.readyState}, seeking ${v.seeking}, paused ${v.paused}, shot ${img.width}x${img.height}, video box ${Math.round(v.getBoundingClientRect().width)}x${Math.round(v.getBoundingClientRect().height)}`;
  }, png);
}

const picture = (page: Page) => page.evaluate(async () => ((await window.otter) as OtterFixture).state().picture);

/** Width (px) of the first white block of the frame number, at the top-left of the player box. */
async function blockWidth(page: Page): Promise<number> {
  const style = await page.addStyleTag({ content: '[data-otter-top], [data-otter-controls], [data-otter-center] { visibility: hidden !important; }' });
  const png = (await page.locator('#player').screenshot({ animations: 'disabled' })).toString('base64');
  await style.evaluate((el) => (el as Element).remove());
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    // A row through the blocks: the length of the longest bright run.
    const y = Math.round(img.height * 0.03);
    const row = ctx.getImageData(0, y, img.width, 1).data;
    let best = 0;
    let run = 0;
    for (let x = 0; x < img.width; x++) {
      const bright = (row[x * 4] as number) + (row[x * 4 + 1] as number) + (row[x * 4 + 2] as number) > 600;
      run = bright ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return best / devicePixelRatio;
  }, png);
}

async function load(page: Page, p: (typeof PATHS)[number]): Promise<void> {
  await page.goto('/player.html?idle=0');
  await page.evaluate(
    async ([src, blob]) => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('set-muted', { muted: true });
      o.load({ src: blob ? await o.fetchBlob(src) : src });
    },
    [p.src, p.blob] as const,
  );
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().status), { timeout: 30_000 }).toBe('ready');
}

for (const p of PATHS) {
  test(`picture controls on the ${p.name} path: wheel and pinch zoom, drag pans, filters from the menu`, async ({ page, browserName }) => {
    test.setTimeout(90_000);
    // WebKit: after a paused seek the <video> may keep showing an older frame (frame 1 at currentTime
    // 0.11, readyState 4; re-seeking and a play-one-frame nudge do not fix it: RESEARCH §1, M6). A
    // platform limitation: frame-exact work on Safari uses the WebCodecs path (the webcodecs case).
    if (p.name === 'video' && browserName === 'webkit') {
      ciNotice('picture controls on the video path: WebKit paused seeks may not repaint (RESEARCH §1), skipped; the WebCodecs path covers WebKit');
      test.skip(true, 'WebKit paused seek does not repaint the <video> (RESEARCH §1)');
    }
    await load(page, p);
    // Frame 3: bits 0 and 1, two white blocks side by side at the top-left (a 96 px run of the
    // 640 px picture), so a 2x zoom there still fits the box.
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('seek', { time: 3 / 30 + 0.01 }));
    await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().seeking), { timeout: 10_000 }).toBe(false);
    const box = (await page.locator('#player').boundingBox()) as { x: number; y: number; width: number; height: number };
    // Two 96 px blocks of the 640 px picture, at the player's width.
    // Known flaky on CI's emulated iPhone (owner 2026-10-27: retried, decided on a real iPhone in
    // M7; RESEARCH §1): the row reads no bright pixel at all even after the seek is repeated.
    if (test.info().project.name === 'emulated-iphone') test.info().annotations.push({ type: 'flaky', description: 'emulated iPhone: no frame-number block read (RESEARCH §1), retried; M7' });
    // A paused WebKit sometimes keeps showing the GOP's keyframe (frame 0: no block at all) after
    // a seek inside the GOP (RESEARCH §1; the fixture has a keyframe every 90 frames): the seek
    // is issued again while the reading is still that keyframe.
    // Every reading and re-seek, with what the screen showed, goes to a notice when this fails
    // (the emulated-iPhone flake: located from CI notices, owner 2026-10-28).
    const trail: string[] = [];
    const started = Date.now();
    try {
      await expect
        .poll(
          async () => {
            const w = (await blockWidth(page)) / box.width;
            if (w <= 0.12) {
              trail.push(`${Date.now() - started} ms: width ${w.toFixed(3)}; ${await screenState(page)}; re-seek`);
              await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('seek', { time: 3 / 30 + 0.01 }));
            }
            return w;
          },
          { message: 'two 1-bits read as one bright run', timeout: 15_000, intervals: [500, 1000, 2000] },
        )
        .toBeGreaterThan(0.12);
    } catch (err) {
      ciNotice(`picture block read failed on the ${p.name} path (retry ${test.info().retry}): ${trail.join(' | ')}; now ${await screenState(page)}`);
      throw err;
    }
    if (trail.length > 0) ciNotice(`picture block read on the ${p.name} path needed ${trail.length} re-seeks (retry ${test.info().retry}): ${trail.join(' | ')}`);
    await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().seeking), { timeout: 10_000 }).toBe(false);
    const base = await blockWidth(page);
    expect(base / box.width).toBeLessThan(0.18);

    // Ctrl + wheel at the top-left corner: zoom in there. Playwright has no wheel in mobile
    // WebKit (a phone has none either): there the same zoom-at the wheel sends is dispatched.
    const wheel = !test.info().project.name.includes('iphone');
    if (wheel) {
      await page.mouse.move(box.x + 2, box.y + 2);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -350);
      await page.keyboard.up('Control');
    } else {
      await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('zoom-at', { factor: 2, x: 0, y: 0 }));
    }
    // How far one wheel step goes depends on the engine's wheel deltas; the picture must follow
    // whatever zoom resulted.
    await expect.poll(async () => (await picture(page)).zoom).toBeGreaterThan(1.25);
    await page.waitForTimeout(200);
    const z = (await picture(page)).zoom;
    // At the corner: the two white blocks are still at the top-left, z times as wide.
    await expect.poll(() => blockWidth(page), { timeout: 5_000 }).toBeGreaterThan(base * z * 0.85);
    expect(await blockWidth(page)).toBeLessThan(base * z * 1.15);
    // The page did not scroll (the wheel was ours).
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // Plain wheel down while zoomed: zooms back out, still no scroll.
    if (wheel) await page.mouse.wheel(0, 2000);
    else await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('zoom-at', { factor: 0.1, x: 0.5, y: 0.5 }));
    await expect.poll(async () => (await picture(page)).zoom).toBe(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // And plain wheel unzoomed scrolls the page as usual (passive for us).
    // Two-finger pinch out (touch): zoom in at the centre.
    // Touch pinch through CDP (Chromium); other engines run the wheel and menu parts.
    const cdp = test.info().project.name.includes('firefox') ? undefined : await page.context().newCDPSession(page).catch(() => undefined);
    if (cdp !== undefined) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', d: number): Promise<void> =>
        void (await cdp.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchEnd' ? [] : [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }],
        }));
      await touch('touchStart', 40);
      for (const d of [60, 80, 100, 120]) await touch('touchMove', d);
      await touch('touchEnd', 0);
      await expect.poll(async () => (await picture(page)).zoom).toBeGreaterThan(2.5);
      // Drag pans the zoomed picture (and stays inside it).
      const before = (await picture(page)).pan;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 120, cy + 40, { steps: 6 });
      await page.mouse.up();
      const after = (await picture(page)).pan;
      expect(after[0]).toBeGreaterThan(before[0]);
      expect(after[1]).toBeGreaterThan(before[1]);
      // A drag is not a click: playback state did not toggle.
      expect(await page.evaluate(async () => ((await window.otter) as OtterFixture).state().paused)).toBe(true);
    }

    // Settings -> Picture -> Brightness 125%: the filter reaches the surface that shows the picture.
    await page.locator('otter-settings-menu').getByRole('button').click();
    await page.locator('otter-settings-menu').getByRole('menuitem', { name: /^Picture,/ }).click();
    await page.locator('otter-settings-menu').getByRole('menuitemradio', { name: '125%' }).first().click();
    await expect.poll(async () => (await picture(page)).filters.brightness).toBe(1.25);
    const filter = await page.locator(p.picture).evaluate((el) => (el as HTMLElement).style.filter);
    if (p.name === 'video') expect(filter).toContain('brightness(1.25)');
    // Original picture: everything back.
    await page.locator('otter-settings-menu').getByRole('menuitemradio', { name: 'Original picture' }).click();
    await expect.poll(async () => picture(page)).toMatchObject({ zoom: 1, pan: [0, 0], filters: { brightness: 1 } });
  });
}
