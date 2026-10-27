// Scenario presets (ADR-013, M6 batch 2): `vod`, `live` and `background` as a host uses them, one
// call with a container and a source (e2e/site/presets.ts), no hand wiring.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { Player } from '@otter-player/presets';
import type { BackgroundPlayer } from '@otter-player/presets/background';

const state = (page: Page) => page.evaluate(() => (window.preset as Player).store.getState());

test('vod preset: builds the shell, plays HLS on the own engine, controls drive it, captions offered', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(r.url());
  });
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
  expect(scripts.some((u) => /hls(\.light)?(\.min)?\.m?js|hls-[\w-]+\.js/.test(u))).toBe(false);
  expect(s.textTracks.length).toBeGreaterThan(0);
  // A play button of the shell pauses it (phones show the centre one, desktops the bar's too).
  await page.locator('otter-play-button').getByRole('button').filter({ visible: true }).first().click();
  await expect.poll(async () => (await state(page)).paused).toBe(true);
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

test('background preset (Hero): muted inline loop without UI, playing; reduced motion leaves it still', async ({ page }) => {
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
