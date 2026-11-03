// The shorts preset's portrait gestures (ADR-013 batch 4) on the emulated phones: vertical swipes
// switch the feed (past a distance, or a short quick flick; a slow short drag snaps back), a tap
// pauses / plays, a double tap is the host's like, a long press plays at 2x while held. One video
// element, one engine: while switching, at most ONE live MediaSource, one playing video and one
// <video> element (the previous engine is torn down before the next loads; no preloading).
//
// The swipes are pointer events dispatched on the picture with pointerType touch, at real time
// steps (Playwright has no touch drag; the recognizer reads pointer events whatever made them).
// The tap is a real touchscreen tap.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { ShortsPlayer } from '@otter-player/presets/shorts';

const FEED = ['/frames/h264.mp4', '/hls-fmp4/master.m3u8', '/frames/h264.mp4'];

test.beforeEach(({}, info) => {
  test.skip(!info.project.name.startsWith('emulated'), 'portrait gestures: the emulated phones');
});

const shorts = (page: Page) => page.evaluate(() => ({ index: (window.preset as ShortsPlayer).index, s: (window.preset as ShortsPlayer).store.getState(), rate: (window.preset as ShortsPlayer).video.playbackRate }));

async function open(page: Page): Promise<void> {
  // Every MediaSource the page makes, to count the live ones (readyState not 'closed').
  await page.addInitScript(() => {
    const w = window as unknown as { sources: MediaSource[]; peak: { sources: number; playing: number } };
    w.sources = [];
    w.peak = { sources: 0, playing: 0 };
    for (const name of ['MediaSource', 'ManagedMediaSource'] as const) {
      const Native = (window as unknown as Record<string, typeof MediaSource | undefined>)[name];
      if (Native === undefined) continue;
      (window as unknown as Record<string, unknown>)[name] = class extends Native {
        constructor() {
          super();
          w.sources.push(this);
        }
      };
    }
    // Sampled every 10 ms: live MediaSources and playing videos at any moment.
    setInterval(() => {
      const live = w.sources.filter((s) => s.readyState !== 'closed').length;
      const playing = [...document.querySelectorAll('video')].filter((v) => !v.paused && v.readyState >= 2).length;
      w.peak.sources = Math.max(w.peak.sources, live);
      w.peak.playing = Math.max(w.peak.playing, playing);
    }, 10);
  });
  await page.goto(`/presets.html?preset=shorts&feed=${FEED.join(',')}`);
  await expect.poll(async () => (await shorts(page)).s.currentTime, { timeout: 15_000 }).toBeGreaterThan(0.3);
}

/** A vertical drag on the picture: `dy` px over `ms`, in `steps` moves (touch pointer events). */
const swipe = (page: Page, dy: number, ms: number, steps = 8) =>
  page.evaluate(
    async ([dy, ms, steps]) => {
      const root = document.getElementById('player') as HTMLElement;
      const r = root.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y0 = r.top + r.height * (dy < 0 ? 0.7 : 0.3);
      const target = root.querySelector('video') ?? root;
      const ev = (type: string, y: number) => target.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
      ev('pointerdown', y0);
      for (let i = 1; i <= steps; i++) {
        await new Promise((res) => setTimeout(res, ms / steps));
        ev('pointermove', y0 + (dy * i) / steps);
      }
      ev('pointerup', y0 + dy);
    },
    [dy, ms, steps] as const,
  );

const height = (page: Page) => page.evaluate(() => (document.getElementById('player') as HTMLElement).getBoundingClientRect().height);

test('shorts: swipe up / down switches past the distance; a short quick flick switches; a slow short drag snaps back; at most one decoding instance alive', async ({ page }) => {
  await open(page);
  const h = await height(page);
  // Long, slow swipe up (past 20 % of the height): next.
  await swipe(page, -0.4 * h, 600);
  await expect.poll(async () => (await shorts(page)).index).toBe(1);
  await expect.poll(async () => (await shorts(page)).s.currentTime, { timeout: 15_000 }).toBeGreaterThan(0.3);
  expect((await shorts(page)).s.format).toBe('hls');
  // Short (40 px) and quick (60 ms): a flick, next again.
  await swipe(page, -40, 60, 4);
  await expect.poll(async () => (await shorts(page)).index).toBe(2);
  await expect.poll(async () => (await shorts(page)).s.currentTime, { timeout: 15_000 }).toBeGreaterThan(0.3);
  // Short (40 px) and slow (800 ms): no switch, the picture snaps back.
  await swipe(page, 40, 800);
  await page.waitForTimeout(400);
  expect((await shorts(page)).index).toBe(2);
  expect(await page.evaluate(() => (document.querySelector('#player video') as HTMLVideoElement).style.transform)).toBe('');
  // Long swipe down: previous.
  await swipe(page, 0.4 * h, 500);
  await expect.poll(async () => (await shorts(page)).index).toBe(1);
  // Past the end of the feed nothing happens.
  await swipe(page, 0.4 * h, 500);
  await expect.poll(async () => (await shorts(page)).index).toBe(0);
  await swipe(page, 0.4 * h, 500);
  await page.waitForTimeout(500);
  expect((await shorts(page)).index).toBe(0);
  // Through all of it: one live MediaSource and one playing video at most.
  const peak = await page.evaluate(() => (window as unknown as { peak: { sources: number; playing: number }; sources: unknown[] }).peak);
  const made = await page.evaluate(() => (window as unknown as { sources: unknown[] }).sources.length);
  test.info().annotations.push({ type: 'instances', description: `peak live MediaSources ${peak.sources}, playing videos ${peak.playing}, MediaSources made ${made}` });
  expect(peak.sources, 'live MediaSources at once').toBeLessThanOrEqual(1);
  expect(peak.playing, 'playing videos at once').toBeLessThanOrEqual(1);
  // The HLS video was loaded twice (index 1, there and back): each load its own MediaSource, the
  // previous one closed first. (The MP4s may play from the element's own src: no MediaSource.)
  expect(made, 'a MediaSource per HLS load').toBeGreaterThanOrEqual(2);
  // The element itself: one <video> for the whole feed.
  expect(await page.locator('#player video').count()).toBe(1);
});

test('shorts: a tap pauses and plays; a double tap is the like hook (and does not pause); a long press plays at 2x while held', async ({ page }) => {
  await open(page);
  const box = (await page.locator('#player').boundingBox()) as { x: number; y: number; width: number; height: number };
  const centre = { x: box.x + box.width / 2, y: box.y + box.height * 0.4 };
  // A real tap: paused once the double-tap window has passed.
  await page.touchscreen.tap(centre.x, centre.y);
  await expect.poll(async () => (await shorts(page)).s.paused).toBe(true);
  await page.touchscreen.tap(centre.x, centre.y);
  await expect.poll(async () => (await shorts(page)).s.paused).toBe(false);
  // Double tap: the like, with the feed index and where; the video keeps playing.
  await page.evaluate(([x, y]) => {
    const t = document.querySelector('#player video') as HTMLVideoElement;
    for (const type of ['pointerdown', 'pointerup', 'pointerdown', 'pointerup']) t.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, composed: true }));
  }, [centre.x, centre.y] as const);
  await expect.poll(() => page.evaluate(() => window.likes?.length ?? 0)).toBe(1);
  const like = (await page.evaluate(() => window.likes?.[0])) as { index: number; x: number; y: number };
  expect(like.index).toBe(0);
  expect(like.x).toBeCloseTo(0.5, 1);
  await page.waitForTimeout(400);
  expect((await shorts(page)).s.paused).toBe(false);
  // Long press: 2x while held, back to 1x on release.
  await page.evaluate(([x, y]) => {
    const t = document.querySelector('#player video') as HTMLVideoElement;
    t.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, composed: true }));
  }, [centre.x, centre.y] as const);
  await expect.poll(async () => (await shorts(page)).rate, { timeout: 2000 }).toBe(2);
  await page.evaluate(([x, y]) => {
    const t = document.querySelector('#player video') as HTMLVideoElement;
    t.dispatchEvent(new PointerEvent('pointerup', { pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, composed: true }));
  }, [centre.x, centre.y] as const);
  await expect.poll(async () => (await shorts(page)).rate).toBe(1);
  expect((await shorts(page)).s.paused).toBe(false);
  // A tap on a control is the control's, not a gesture.
  await page.locator('#player [data-otter-controls] otter-mute-button').getByRole('button').tap();
  await page.waitForTimeout(400);
  expect((await shorts(page)).s.paused).toBe(false);
});
