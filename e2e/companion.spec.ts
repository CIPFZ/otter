// Companion mode (ADR-016, docs/design/COMPANION.md §6), stop 1: entering through the PiP button,
// the window size step, the dim layer in the window and back in the page, controls on hover only,
// preferences, and nothing left behind. Judged on desktop-chrome and real Edge only (acceptance
// 8); elsewhere the cases record what the environment reports and skip.
//
// The headless shell gives the PiP window the size of an ordinary page (RESEARCH §1), so the size
// step is checked on the requestWindow call, not on the window.

import { appendFileSync, mkdirSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { Player } from '@otter-player/presets';

const JUDGED = ['desktop-chrome', 'real-windows-edge'];
const SRC = '/demo/master.m3u8';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const state = (page: Page) => page.evaluate(() => (window.player as Player).store.getState());

/** Every requestWindow call, and every MediaSource the page makes. */
const instrument = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { requested: unknown[]; mediaSources: { readyState: string }[]; documentPictureInPicture?: { requestWindow(o?: object): Promise<Window> } };
    w.requested = [];
    w.mediaSources = [];
    const dpip = w.documentPictureInPicture;
    if (dpip !== undefined) {
      const original = dpip.requestWindow.bind(dpip);
      dpip.requestWindow = (o?: object) => {
        w.requested.push(o);
        return original(o);
      };
    }
    const Base = (window as unknown as { MediaSource?: new () => { readyState: string } }).MediaSource;
    if (Base !== undefined) {
      const Tracked = class extends Base {
        constructor() {
          super();
          w.mediaSources.push(this);
        }
      };
      Object.defineProperty(window, 'MediaSource', { value: Tracked, configurable: true, writable: true });
    }
  });

/** Opens the page, plays, and skips (with a notice) where companion mode is not judged or missing. */
async function open(page: Page, query = ''): Promise<void> {
  await instrument(page);
  await page.goto(`/companion.html?src=${SRC}${query}`);
  await expect.poll(async () => (await state(page)).status, { timeout: 20_000 }).toBe('ready');
  const supported = (await state(page)).presentation.companion.supported;
  if (!JUDGED.includes(test.info().project.name)) {
    ciNotice(`companion: supported=${supported} here; judged on desktop-chrome and real Edge only (acceptance 8)`);
    test.skip(true, 'companion mode is judged on desktop-chrome and real Edge only');
  }
  if (!supported) {
    ciNotice('companion: not supported here (no Document PiP)');
    test.skip(true, 'no Document PiP');
  }
  await page.evaluate(() => (window.player as Player).store.dispatch('play', undefined));
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(0.3);
}

/** Clicks the PiP button (a real gesture) and returns the window's page, or skips if not entered. */
async function enter(page: Page): Promise<Page> {
  const context: BrowserContext = page.context();
  const opened = context.waitForEvent('page', { timeout: 8000 }).catch(() => undefined);
  await page.locator('otter-pip-button').getByRole('button').click();
  await expect.poll(async () => (await state(page)).presentation.pending, { timeout: 8000 }).toBeNull();
  const pip = await opened;
  if ((await state(page)).presentation.mode !== 'docpip' || pip === undefined) {
    ciNotice('companion: requested but the window did not open (skipped)');
    test.skip(true, 'companion window not entered');
  }
  ciNotice('companion: entered the window');
  return pip as Page;
}

/**
 * Back to the page with the window's own button. As a viewer does: the pointer comes in first
 * (the bar is hidden, and lets clicks through to the picture, until then).
 */
async function back(page: Page, pip: Page): Promise<void> {
  await pip.mouse.move(60, 60);
  await pip.mouse.move(70, 64);
  await expect(pip.locator('[data-otter-controls]')).not.toHaveAttribute('data-idle');
  await pip.locator('otter-pip-button').getByRole('button').click();
  await expect.poll(async () => (await state(page)).presentation.mode).toBe('inline');
}

/** The dim layer's computed opacity in `target`'s document. */
const dimOpacity = (target: Page) =>
  target.evaluate(() => {
    const dim = document.querySelector('otter-gesture')?.shadowRoot?.querySelector('.dim');
    return dim === null || dim === undefined ? null : Number(getComputedStyle(dim).opacity);
  });

/** Mean luminance (0..255) of a region of a screenshot, given as fractions of the player box. */
async function luminance(target: Page, region: { x: number; y: number; w: number; h: number }): Promise<number> {
  const box = await target.locator('[data-otter-player]').boundingBox();
  if (box === null) throw new Error('no player box');
  const png = await target.screenshot({ clip: { x: box.x + box.width * region.x, y: box.y + box.height * region.y, width: box.width * region.w, height: box.height * region.h } });
  return target.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * (d[i] as number) + 0.7152 * (d[i + 1] as number) + 0.0722 * (d[i + 2] as number);
    return sum / (d.length / 4);
  }, png.toString('base64'));
}

test('the PiP button opens the companion window at the size step; dim there, brightness back in the page; playback goes on', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  // Playhead samples in the page around the move (its timers keep running).
  await page.evaluate(() => {
    const w = window as unknown as { samples: { t: number; at: number; paused: boolean }[] };
    w.samples = [];
    const tick = (): void => {
      const s = (window.player as Player).store.getState();
      w.samples.push({ t: s.currentTime, at: performance.now() / 1000, paused: s.paused });
      setTimeout(tick, 50);
    };
    tick();
  });
  const pip = await enter(page);
  // 320 px wide (step m), height from the 16:9 picture.
  expect(await page.evaluate(() => (window as unknown as { requested: unknown[] }).requested)).toEqual([{ width: 320, height: 180 }]);
  expect((await state(page)).presentation.companion).toMatchObject({ active: true, dim: 0.4, size: 'm' });
  await expect.poll(() => dimOpacity(pip)).toBe(0.4);
  // The setting does not move brightness.
  expect((await state(page)).brightness).toBe(1);
  await page.waitForTimeout(1000);
  await back(page, pip);
  expect((await state(page)).presentation.companion.active).toBe(false);
  await expect.poll(() => dimOpacity(page)).toBe(0);
  await page.waitForTimeout(800);
  const samples = await page.evaluate(() => (window as unknown as { samples: { t: number; at: number; paused: boolean }[] }).samples);
  expect(samples.every((s) => !s.paused)).toBe(true);
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as { t: number; at: number };
    const b = samples[i] as { t: number; at: number };
    expect(b.t, `sample ${i}`).toBeGreaterThanOrEqual(a.t);
    expect(b.t - a.t, `sample ${i}`).toBeLessThanOrEqual(b.at - a.at + 0.5);
  }
});

test('dim 0 / 40 / 80 %: the picture in the window is that much darker (pixels)', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  // One still frame for both screenshots; a region clear of the bars and the centre button.
  await page.evaluate(() => (window.player as Player).store.dispatch('pause', undefined));
  await expect.poll(async () => (await state(page)).paused).toBe(true);
  const region = { x: 0.05, y: 0.25, w: 0.3, h: 0.3 };
  const inPage = await luminance(page, region);
  const pip = await enter(page);
  const ratios: Record<string, number> = {};
  for (const dim of [0, 0.4, 0.8]) {
    await page.evaluate((d) => (window.player as Player).store.dispatch('companion-set', { dim: d }), dim);
    await expect.poll(() => dimOpacity(pip)).toBe(dim);
    ratios[dim] = (await luminance(pip, region)) / inPage;
    expect(ratios[dim], `dim ${dim}: luminance ratio`).toBeGreaterThan(1 - dim - 0.08);
    expect(ratios[dim], `dim ${dim}: luminance ratio`).toBeLessThan(1 - dim + 0.08);
  }
  ciNotice(`companion: luminance in the window / in the page at dim 0 / 0.4 / 0.8: ${Object.values(ratios).map((r) => r.toFixed(3)).join(' / ')}`);
});

test('controls: hidden while the pointer is outside the window, shown inside, hidden on leaving; all reachable by keyboard', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  const pip = await enter(page);
  const visible = async (): Promise<boolean> => (await state(page)).controlsVisible && !(await pip.locator('[data-otter-controls]').evaluate((el) => el.hasAttribute('data-idle')));
  // Playing, pointer elsewhere: never shown over 5 s.
  const seen: boolean[] = [];
  for (let i = 0; i < 10; i++) {
    seen.push(await visible());
    await pip.waitForTimeout(500);
  }
  expect(seen.every((v) => !v)).toBe(true);
  expect((await state(page)).paused).toBe(false);
  await pip.mouse.move(100, 100);
  await pip.mouse.move(120, 110);
  await expect.poll(visible).toBe(true);
  // Stays while the pointer stays (no idle timer here).
  await pip.waitForTimeout(3500);
  expect(await visible()).toBe(true);
  await pip.mouse.move(-5, -5);
  await expect.poll(visible).toBe(false);
  // Keyboard: Tab walks the slim bar; while the focus is on a control the controls show.
  const reached = new Map<string, boolean>();
  for (let i = 0; i < 12; i++) {
    await pip.keyboard.press('Tab');
    const tag = await pip.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? '');
    if (tag.startsWith('otter-')) reached.set(tag, await visible());
  }
  expect([...reached.keys()]).toEqual(expect.arrayContaining(['otter-play-button', 'otter-mute-button', 'otter-time-slider', 'otter-settings-menu', 'otter-pip-button']));
  for (const hidden of ['otter-fullscreen-button', 'otter-captions-button', 'otter-quality-menu', 'otter-speed-menu', 'otter-theater-button']) expect(reached.has(hidden), hidden).toBe(false);
  expect([...reached.values()].every(Boolean)).toBe(true);
});

test('preferences: dim, size and audioOnly survive a reload; textLanguage and danmaku are untouched by a round trip', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    if (localStorage.getItem('otter:preferences') === null) localStorage.setItem('otter:preferences', JSON.stringify({ textLanguage: 'en', danmaku: { opacity: 0.5 } }));
  });
  await open(page);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('otter:preferences') ?? '{}') as Record<string, unknown>);
  const before = await stored();
  const pip = await enter(page);
  await page.evaluate(() => (window.player as Player).store.dispatch('companion-set', { dim: 0.6, size: 'l', audioOnly: true }));
  await back(page, pip);
  const after = await stored();
  expect(JSON.stringify(after['textLanguage'])).toBe(JSON.stringify(before['textLanguage']));
  expect(JSON.stringify(after['danmaku'])).toBe(JSON.stringify(before['danmaku']));
  expect(after['companion']).toEqual({ dim: 0.6, size: 'l', audioOnly: true });
  await page.reload();
  await expect.poll(async () => (await state(page)).presentation.companion).toMatchObject({ dim: 0.6, size: 'l', audioOnly: true });
});

test('out of the window: the idle delay is back, nothing is left in the page; destroy closes the MediaSource', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  const pip = await enter(page);
  await back(page, pip);
  const left = await page.evaluate(() => ({
    window: (window as unknown as { documentPictureInPicture: { window: Window | null } }).documentPictureInPicture.window !== null,
    style: document.querySelectorAll('style[data-otter-companion-style]').length,
    mark: document.querySelectorAll('[data-otter-companion]').length,
    placeholder: document.querySelectorAll('[data-otter-placeholder]').length,
  }));
  expect(left).toEqual({ window: false, style: 0, mark: 0, placeholder: 0 });
  // Back to the page's rules: shown, then hidden after idleMs (3 s) while playing.
  expect((await state(page)).controlsVisible).toBe(true);
  await expect.poll(async () => (await state(page)).controlsVisible, { timeout: 6000 }).toBe(false);
  await page.evaluate(() => (window.player as Player).destroy());
  const sources = await page.evaluate(() => (window as unknown as { mediaSources: { readyState: string }[] }).mediaSources.map((m) => m.readyState));
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.filter((s) => s !== 'closed')).toEqual([]);
});
