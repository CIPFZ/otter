// Scenario presets (ADR-013, M6 batch 2) as a host uses them: one call with a container and a
// source (e2e/site/presets.ts), no hand wiring.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { Player } from '@otter-player/presets';
import type { BackgroundPlayer } from '@otter-player/presets/background';

const state = (page: Page) => page.evaluate(() => (window.preset as Player).store.getState());
const explain = (page: Page) => page.evaluate(() => (window.preset as Player).explain());
const HLSJS = /hls(\.light)?(\.min)?\.m?js|hls-[\w-]+\.js/;

function scripts(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') seen.push(r.url());
  });
  return seen;
}

test('basic preset: five controls only, HLS on the own engine and MP4 by range requests, mute and fullscreen work', async ({ page }) => {
  const loaded = scripts(page);
  await page.goto('/presets.html?preset=basic&src=/hls-fmp4/master.m3u8');
  // The shell: play / pause, mute, time, progress, fullscreen; nothing else.
  const tags = await page.locator('#player [data-otter-controls] *').evaluateAll((els) => els.map((e) => e.localName).filter((n) => n.startsWith('otter-')));
  expect(tags.sort()).toEqual(['otter-fullscreen-button', 'otter-mute-button', 'otter-play-button', 'otter-time-display', 'otter-time-slider']);
  await expect(page.locator('#player [data-otter-top], #player otter-settings-menu, #player otter-captions-button')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(0.5);
  let s = await state(page);
  expect(s).toMatchObject({ format: 'hls', backend: 'mse', muted: true });
  expect(loaded.some((u) => HLSJS.test(u))).toBe(false);
  expect((s as { textTracks?: unknown }).textTracks).toBeUndefined();
  // Mute button: sound on.
  await page.locator('otter-mute-button').getByRole('button').click();
  await expect.poll(async () => (await state(page)).muted).toBe(false);
  // Fullscreen of the player root, and back (where the page may enter it).
  const canFullscreen = await page.evaluate(() => document.fullscreenEnabled === true);
  if (canFullscreen) {
    await page.locator('otter-fullscreen-button').getByRole('button').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('player');
    await expect.poll(async () => (await state(page) as unknown as { presentation: { mode: string } }).presentation.mode).toBe('fullscreen');
    await page.locator('otter-fullscreen-button').getByRole('button').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect.poll(async () => (await state(page) as unknown as { presentation: { mode: string } }).presentation.mode).toBe('inline');
  }
  // Progressive MP4 through mp4-range.
  await page.evaluate(() => (window.preset as Player).load('/frames/h264.mp4', { autoplay: true }));
  await expect.poll(async () => (await state(page)).format, { timeout: 15_000 }).toBe('mp4-range');
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(0.5);
  s = await state(page);
  expect(s.error).toBeNull();
  // explain(): the route.
  expect((await explain(page)).route?.format).toBe('mp4-range');
  test.skip(!canFullscreen, 'fullscreen not available here: everything else checked');
});

test('vod preset: builds the shell, plays HLS on the own engine, controls drive it, captions offered, explain()', async ({ page }) => {
  const loaded = scripts(page);
  await page.goto('/presets.html?preset=vod&src=/hls-fmp4/master.m3u8');
  await expect(page.locator('#player[data-otter-player] [data-otter-controls] otter-time-slider')).toHaveCount(1);
  await expect(page.locator('[data-otter-title]')).toHaveText('Preset vod');
  // Muted from the start (the preset's `muted`): WebKit refuses autoplay with sound.
  expect(await page.locator('#player video').evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(0.5);
  const s = await state(page);
  expect(s.format).toBe('hls');
  expect(s.backend).toBe('mse');
  // The own CMAF-HLS engine: no hand-over step, no hls.js module loaded.
  expect((s.route?.steps ?? []).map((x) => x.reason).join('\n')).not.toContain('own engine');
  expect(loaded.some((u) => HLSJS.test(u))).toBe(false);
  expect(s.textTracks.length).toBeGreaterThan(0);
  // Preview pictures: the on-demand chunk arrived and the provider is in place.
  await expect.poll(() => page.evaluate(() => window.hasThumbnails?.() === true)).toBe(true);
  // explain(): the route with its steps, presentation, no error.
  const e = await explain(page);
  expect(e.route?.format).toBe('hls');
  expect(e.route?.steps.length).toBeGreaterThan(0);
  expect(e.presentation.mode).toBe('inline');
  expect(e.error).toBeNull();
  // A play button of the shell pauses it (phones show the centre one, desktops the bar's too).
  await page.locator('otter-play-button').getByRole('button').filter({ visible: true }).first().click();
  await expect.poll(async () => (await state(page)).paused).toBe(true);
});

test('vod preset with captions and thumbnails off: plays, no caption tracks or caption state, no preview-picture provider', async ({ page }) => {
  await page.goto('/presets.html?preset=vod&captions=0&thumbs=0&src=/hls-fmp4/master.m3u8');
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(0.5);
  expect((await state(page)).textTracks).toBeUndefined();
  expect(await page.evaluate(() => window.hasThumbnails?.() === true)).toBe(false);
});

test('live preset: live HLS near HOLD-BACK, the live indicator shows, back to live works', async ({ page }) => {
  await page.goto('/presets.html?preset=live&src=/live-hls/master.m3u8');
  await expect.poll(async () => (await state(page)).live, { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await state(page)).latency ?? 0, { timeout: 20_000 }).toBeGreaterThan(3);
  expect((await state(page)).latency).toBeLessThan(9);
  await expect(page.locator('otter-live-indicator')).toBeVisible();
  await page.evaluate(() => (window.preset as Player).store.dispatch('pause', undefined));
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const p = window.preset as Player;
    p.store.dispatch('seek-to-live', {});
    p.store.dispatch('play', undefined);
  });
  await expect.poll(async () => (await state(page)).latency ?? 99, { timeout: 15_000 }).toBeLessThan(9);
});

test('lowlatency preset: LL-HLS goes straight to hls.js (no first try on the own engine)', async ({ page }) => {
  const loaded = scripts(page);
  await page.goto('/presets.html?preset=lowlatency&src=/hls-unsupported/ll-parts/master.m3u8');
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 20_000 }).toBeGreaterThan(0.5);
  const s = await state(page);
  expect(s.format).toBe('hls');
  expect(s.error).toBeNull();
  expect(loaded.some((u) => HLSJS.test(u))).toBe(true);
  // No own-engine attempt handed over (that would read "own engine does not support ... EXT-X-PART").
  expect((s.route?.steps ?? []).map((x) => x.reason).join('\n')).not.toContain('own engine');
});

test('danmaku preset: DASH A/V plays, comments draw with the renderer explained, watermark on, settings persist', async ({ page }) => {
  await page.goto('/presets.html?preset=danmaku&wm=1&src=/dash-av/manifest.mpd');
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 20_000 }).toBeGreaterThan(0.5);
  expect((await state(page)).format).toBe('dash');
  // The preset loaded the comments itself (`comments` option): nothing dispatched here.
  await expect.poll(async () => page.evaluate(() => ((window.preset as Player).store.getState() as unknown as { danmakuStatus: { count: number } }).danmakuStatus.count), { timeout: 10_000 }).toBeGreaterThan(0);
  const e = await explain(page);
  expect(e.more['danmaku']?.[0]).toMatchObject({ candidate: 'canvas2d', outcome: 'selected' });
  await expect(page.locator('[data-otter-watermark]')).toBeVisible();
  // The viewer's danmaku settings come back on the next visit (preferences).
  await page.evaluate(() => (window.preset as Player).store.dispatch('set-danmaku' as never, { opacity: 0.4 } as never));
  await page.reload();
  await expect.poll(async () => page.evaluate(() => ((window.preset as Player).store.getState() as unknown as { danmaku: { opacity: number } }).danmaku.opacity), { timeout: 10_000 }).toBe(0.4);
});

test('danmaku preset in one call: comments scroll over the picture within 10 s, nothing dispatched by the page', async ({ page }) => {
  await page.goto('/presets.html?preset=danmaku&src=/dash-av/manifest.mpd');
  await page.addStyleTag({ content: '#player video { visibility: hidden !important; } [data-otter-top], [data-otter-controls], [data-otter-center] { visibility: hidden !important; }' });
  /** Bright pixels (comment text) in the picture area. */
  const shot = async (): Promise<{ bright: number; png: string }> => {
    const png = (await page.locator('#player').screenshot({ animations: 'disabled' })).toString('base64');
    const bright = await page.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if ((d[i] as number) + (d[i + 1] as number) + (d[i + 2] as number) > 450) n++;
      return n;
    }, png);
    return { bright, png };
  };
  await expect.poll(async () => (await shot()).bright, { timeout: 10_000 }).toBeGreaterThan(200);
  const a = await shot();
  await page.waitForTimeout(500);
  const b = await shot();
  expect(b.bright).toBeGreaterThan(200);
  // Moving: the two pictures differ.
  expect(a.png).not.toBe(b.png);
  // A load without comments for this video clears them (load option `comments: null`).
  await page.evaluate(() => (window.preset as unknown as { load(s: string, o: object): Promise<void> }).load('/dash-av/manifest.mpd', { autoplay: true, comments: null }));
  await expect.poll(async () => page.evaluate(() => ((window.preset as Player).store.getState() as unknown as { danmakuStatus: { count: number } }).danmakuStatus.count)).toBe(0);
});

test('tv preset: the remote moves focus between controls, OK activates, Back leaves, media keys play / pause', async ({ page }) => {
  test.skip(test.info().project.name.startsWith('emulated'), 'a TV has a remote, not touch');
  // 30 s clip: a 10 s seek from the start stays inside it (the 8 s one would end).
  await page.goto('/presets.html?preset=tv&src=/frames/hls-ladder/master.m3u8');
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(0.3);
  const focused = () =>
    page.evaluate(() => {
      let a = document.activeElement;
      while (a?.shadowRoot?.activeElement != null) a = a.shadowRoot.activeElement;
      const host = (a?.getRootNode() as ShadowRoot | Document) instanceof ShadowRoot ? ((a?.getRootNode() as ShadowRoot).host as Element) : a;
      return host === null || host === undefined ? '' : host.id === 'player' ? 'player' : host.tagName.toLowerCase();
    });
  await page.locator('#player').focus();
  // Down on the picture: controls up, focus in the bar.
  await page.keyboard.press('ArrowDown');
  const first = await focused();
  expect(first).toMatch(/^otter-/);
  // Right moves to another control, Left comes back.
  await page.keyboard.press('ArrowRight');
  const second = await focused();
  expect(second).toMatch(/^otter-/);
  expect(second).not.toBe(first);
  // Back leaves the controls: focus on the player again.
  await page.keyboard.press('Escape');
  expect(await focused()).toBe('player');
  // On the picture, Left / Right seek; media keys play and pause.
  const before = (await state(page)).currentTime;
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(before + 1);
  // Media keys: Playwright's WebDriver BiDi (real-windows-firefox) does not know MediaPlayPause
  // (RESEARCH §1); there the pause goes through Space, the remote's OK on the picture.
  await page.keyboard.press(test.info().project.name === 'real-windows-firefox' ? 'Space' : 'MediaPlayPause');
  await expect.poll(async () => (await state(page)).paused).toBe(true);
  // OK on the focused play button plays again.
  await page.keyboard.press('ArrowDown');
  const play = page.locator('[data-otter-controls] otter-play-button').getByRole('button');
  await play.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).paused).toBe(false);
});

test('background preset (Hero): muted inline loop without UI, playing; reduced motion leaves it still', async ({ page }) => {
  // That Windows machine has system animations off (prefers-reduced-motion: reduce) and BiDi cannot
  // emulate it away: the preset rightly stays still (RESEARCH §1, M6 test round F7).
  test.skip(test.info().project.name === 'real-windows-firefox', 'no reducedMotion emulation through WebDriver BiDi');
  await page.goto('/presets.html?preset=background&src=/frames/h264-video-only.mp4');
  const video = page.locator('#hero video');
  await expect(video).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(async () => page.evaluate(() => (window.preset as BackgroundPlayer).store.getState().currentTime), { timeout: 15_000 }).toBeGreaterThan(0.3);
  expect(await video.evaluate((v: HTMLVideoElement) => ({ muted: v.muted, loop: v.loop, inline: v.playsInline, controls: v.controls }))).toEqual({ muted: true, loop: true, inline: true, controls: false });
  expect(await page.locator('[data-otter-controls], otter-play-button').count()).toBe(0);
  expect(await page.evaluate(() => (window.preset as BackgroundPlayer).store.getState().status)).toBe('ready');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForTimeout(1500);
  expect(await page.locator('#hero video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});
