// Companion mode (ADR-016, docs/design/COMPANION.md §6): entering through the PiP button, the
// window size step, the dim layer in the window and back in the page, controls on hover only,
// preferences, nothing left behind (stop 1); the audio strip, quiet, closing the window, the
// settings page and axe in the window's document (stop 2); WebCodecs without audio underruns, and
// where there is no Document PiP (an iframe, Firefox without it, WebKit) the old PiP rules (stop 3). Judged on desktop-chrome and real Edge only (acceptance
// 8); elsewhere the cases record what the environment reports and skip.
//
// The headless shell gives the PiP window the size of an ordinary page (RESEARCH §1), so the size
// step is checked on the requestWindow call, not on the window.

import AxeBuilder from '@axe-core/playwright';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { Player } from '@otter-player/presets';
import type { OtterFixture } from './site/player.ts';

// OTTER_COMPANION_JUDGE=<project>,...: judge more projects (e.g. real-windows-firefox: Firefox 160
// has Document PiP, RESEARCH §1).
const JUDGED = ['desktop-chrome', 'real-windows-edge', ...(process.env['OTTER_COMPANION_JUDGE'] ?? '').split(',').filter(Boolean)];
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

// A companion window left open at the end of a test: closed from the page. Playwright's Firefox
// fails to close the context while a Document PiP window is open (Browser.removeBrowserContext:
// "_maybeDontRestoreTabs", Firefox 157 build on Windows).
test.afterEach(async ({ page }) => {
  await page
    .evaluate(() => (window as unknown as { documentPictureInPicture?: { window: Window | null } }).documentPictureInPicture?.window?.close())
    .catch(() => undefined);
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
  // The click closes the window it is in: Playwright may report the page closed as it finishes.
  await pip
    .locator('otter-pip-button')
    .getByRole('button')
    .click()
    .catch((e: unknown) => {
      if (!/closed/.test(String(e))) throw e;
    });
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
  // The page's own rect: Playwright's boundingBox() does not answer in a Firefox PiP window (BiDi).
  const box = await target.evaluate(() => {
    const r = (document.querySelector('[data-otter-player]') as HTMLElement).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
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
  expect(await page.evaluate(() => (window as unknown as { requested: unknown[] }).requested)).toEqual([{ width: 320, height: 180, disallowReturnToOpener: true }]);
  expect((await state(page)).presentation.companion).toMatchObject({ active: true, dim: 0.4 });
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
  // Out of the window. WebDriver BiDi (Firefox) refuses a pointer move outside the viewport: there
  // the leave is checked by the unit tests (bindActivity) only.
  const left = await pip.mouse.move(-5, -5).then(
    () => true,
    (e: unknown) => {
      if (!/out of bounds/.test(String(e))) throw e;
      return false;
    },
  );
  if (left) await expect.poll(visible).toBe(false);
  else {
    ciNotice('companion controls: the pointer cannot leave the viewport through WebDriver BiDi; leave not checked here');
    await pip.keyboard.press('Tab');
  }
  // Keyboard: Tab walks the slim bar and the window's own controls (dimming slider, audio strip
  // switch); while the focus is on a control the controls show.
  const reached = new Map<string, boolean>();
  for (let i = 0; i < 14; i++) {
    await pip.keyboard.press('Tab');
    const key = await pip.evaluate(() => {
      const el = document.activeElement;
      if (el === null) return '';
      const tag = el.tagName.toLowerCase();
      if (tag.startsWith('otter-')) return tag;
      return el.classList.contains('ot-dim-toggle') ? 'dim-button' : el.classList.contains('ot-strip') ? 'strip-switch' : el.getAttribute('role') === 'slider' && el.classList.contains('ot-dim') ? 'dim-slider' : '';
    });
    if (key !== '') reached.set(key, await visible());
  }
  expect([...reached.keys()]).toEqual(expect.arrayContaining(['otter-play-button', 'otter-mute-button', 'otter-time-slider', 'otter-pip-button', 'dim-button', 'strip-switch']));
  // The slider stays closed (and out of the tab order) until the dimming button opens it.
  for (const hidden of ['dim-slider', 'otter-settings-menu', 'otter-fullscreen-button', 'otter-captions-button', 'otter-quality-menu', 'otter-speed-menu', 'otter-theater-button']) expect(reached.has(hidden), hidden).toBe(false);
  expect([...reached.values()].every(Boolean)).toBe(true);
});

test('preferences: dim and audioOnly survive a reload; textLanguage and danmaku are untouched by a round trip', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    if (localStorage.getItem('otter:preferences') === null) localStorage.setItem('otter:preferences', JSON.stringify({ textLanguage: 'en', danmaku: { opacity: 0.5 } }));
  });
  await open(page);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('otter:preferences') ?? '{}') as Record<string, unknown>);
  const before = await stored();
  const pip = await enter(page);
  await page.evaluate(() => (window.player as Player).store.dispatch('companion-set', { dim: 0.6, audioOnly: true }));
  await back(page, pip);
  const after = await stored();
  expect(JSON.stringify(after['textLanguage'])).toBe(JSON.stringify(before['textLanguage']));
  expect(JSON.stringify(after['danmaku'])).toBe(JSON.stringify(before['danmaku']));
  expect(after['companion']).toEqual({ dim: 0.6, audioOnly: true });
  await page.reload();
  await expect.poll(async () => (await state(page)).presentation.companion).toMatchObject({ dim: 0.6, audioOnly: true });
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

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const blocking = (results: Awaited<ReturnType<AxeBuilder['analyze']>>): string[] =>
  results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.impact}): ${v.help} [${v.nodes.map((n) => n.target.join(' ')).join(', ')}]`);
/**
 * axe on the PiP window's document, with the same rules (WCAG_TAGS) and verdict (blocking()) as
 * elsewhere.
 *
 * Observed on real Edge 157 (2026-11-17): in about one window in eight, the window's document and
 * its root element have prototypes that are not the window's own (`document.documentElement
 * instanceof Element` is false there, `document instanceof Node` is true); axe, which checks nodes
 * with `instanceof window.Element`, then throws "No elements found for include in page Context" for
 * that whole window, retries included. Otter's own code checks nodeType instead (97e87f7). So:
 * where the window's own prototypes hold, axe runs in the window; otherwise it runs in the page
 * that opened it, on the window's document (the same DOM), with a notice.
 */
const AXE_SOURCE = readFileSync(createRequire(createRequire(import.meta.url).resolve('@axe-core/playwright')).resolve('axe-core/axe.min.js'), 'utf8');
type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
const axeIn = (target: Page, opener: Page, label: string) => ({
  analyze: async (): Promise<AxeResults> => {
    await target.waitForFunction(() => document.querySelector('[data-otter-player]') !== null);
    const ownRealm = await target.evaluate(() => document.documentElement instanceof Element);
    if (ownRealm) {
      await target.evaluate(AXE_SOURCE);
      return target.evaluate(
        (tags) => (window as unknown as { axe: { run(options: object): Promise<AxeResults> } }).axe.run({ runOnly: { type: 'tag', values: tags } }),
        WCAG_TAGS,
      );
    }
    const where = await opener.evaluate(() => {
      const d = (window as unknown as { documentPictureInPicture: { window: Window } }).documentPictureInPicture.window.document;
      return { docIsOpenerNode: d instanceof Node, rootIsOpenerElement: d.documentElement instanceof Element, rootProtoOpener: Object.getPrototypeOf(d.documentElement) === HTMLHtmlElement.prototype };
    });
    ciNotice(`companion axe (${label}): the window's nodes are not of its own realm here (${JSON.stringify(where)}); scanned its document from the opener`);
    await opener.evaluate(AXE_SOURCE);
    return opener.evaluate(
      (tags) =>
        (window as unknown as { axe: { run(context: object, options: object): Promise<AxeResults> } }).axe.run(
          { include: [(window as unknown as { documentPictureInPicture: { window: Window } }).documentPictureInPicture.window.document.documentElement] },
          { runOnly: { type: 'tag', values: tags } },
        ),
      WCAG_TAGS,
    );
  },
});

test('audio strip: 66 px of content requested, no picture, the strip bar always shown without settings', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page, '&audio=1');
  const pip = await enter(page);
  expect(await page.evaluate(() => (window as unknown as { requested: unknown[] }).requested)).toEqual([{ width: 320, height: 66, disallowReturnToOpener: true }]);
  const shown = (selector: string) => pip.locator(selector).first().evaluate((el) => getComputedStyle(el).display !== 'none');
  expect(await shown('[data-otter-player] > video')).toBe(false);
  expect(await shown('[data-otter-player] > otter-gesture')).toBe(false);
  for (const tag of ['otter-play-button', 'otter-mute-button', 'otter-time-slider', 'otter-time-display', 'otter-pip-button']) expect(await shown(tag), tag).toBe(true);
  expect(await shown('otter-settings-menu')).toBe(false);
  // Shown with the pointer elsewhere, while playing, past the idle delay.
  await pip.waitForTimeout(3500);
  expect((await state(page)).controlsVisible).toBe(true);
  expect(await pip.locator('[data-otter-controls]').evaluate((el) => el.hasAttribute('data-idle'))).toBe(false);
  expect((await state(page)).paused).toBe(false);
  await back(page, pip);
  expect(await page.locator('[data-otter-player] > video').evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
});

test('quiet: captions off in the window and back after; the preference is not written', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  // The demo's English subtitles, chosen before (this writes textLanguage: en).
  await expect.poll(async () => (await state(page)).textTracks.length, { timeout: 10_000 }).toBeGreaterThan(0);
  const track = (await state(page)).textTracks[0]?.id as string;
  await page.evaluate((id) => (window.player as Player).store.dispatch('select-text-track', { id }), track);
  await expect.poll(async () => (await state(page)).textTrack).toBe(track);
  const stored = () => page.evaluate(() => localStorage.getItem('otter:preferences'));
  const before = JSON.parse((await stored()) ?? '{}') as Record<string, unknown>;
  const pip = await enter(page);
  await expect.poll(async () => (await state(page)).textTrack).toBeNull();
  expect((await state(page)).presentation.companion.quieted).toBe(true);
  await back(page, pip);
  await expect.poll(async () => (await state(page)).textTrack).toBe(track);
  expect((await state(page)).presentation.companion.quieted).toBe(false);
  const after = JSON.parse((await stored()) ?? '{}') as Record<string, unknown>;
  expect(JSON.stringify(after['textLanguage'])).toBe(JSON.stringify(before['textLanguage']));
});

test('closing the window: paused by default, playing on with onClose continue', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  await enter(page);
  // As the viewer closing it (not the player's own way back): closed from outside the player
  // (Playwright's page.close() on a PiP window hangs through WebDriver BiDi).
  const closeWindow = () => page.evaluate(() => (window as unknown as { documentPictureInPicture: { window: Window | null } }).documentPictureInPicture.window?.close());
  await closeWindow();
  await expect.poll(async () => (await state(page)).presentation.mode).toBe('inline');
  await expect.poll(async () => (await state(page)).paused).toBe(true);
  await page.goto(`/companion.html?src=${SRC}&onclose=continue`);
  await expect.poll(async () => (await state(page)).status, { timeout: 20_000 }).toBe('ready');
  await page.evaluate(() => (window.player as Player).store.dispatch('play', undefined));
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(0.3);
  await enter(page);
  await closeWindow();
  await expect.poll(async () => (await state(page)).presentation.mode).toBe('inline');
  await page.waitForTimeout(1000);
  expect((await state(page)).paused).toBe(false);
});

for (const lang of ['en', 'zh-CN'] as const) {
  test(`settings: the ${lang} companion page in the page (dimming, audio strip; no size)`, async ({ page }) => {
    test.setTimeout(60_000);
    const t = lang === 'en' ? { title: 'Floating player', on: 'On' } : { title: '悬浮窗', on: '开' };
    await open(page, `&lang=${lang}`);
    await page.locator('otter-settings-menu').getByRole('button').first().click();
    await page.getByRole('menuitem', { name: new RegExp(`^${t.title}`) }).click();
    await expect(page.getByRole('menuitemradio', { name: '80%' })).toBeVisible();
    expect(await page.getByRole('menuitemradio').allTextContents()).toEqual(expect.arrayContaining(['0%', '20%', '40%', '60%', '80%', t.on]));
    await page.getByRole('menuitemradio', { name: '80%' }).click();
    await expect.poll(async () => (await state(page)).presentation.companion.dim).toBe(0.8);
  });

  test(`window controls (${lang}): a dimming button that opens a five-step slider, the audio strip switch, no settings menu`, async ({ page }) => {
    test.setTimeout(60_000);
    const t = lang === 'en' ? { dim: 'Dimming', strip: 'Audio only', picture: 'Show picture' } : { dim: '暗化', strip: '纯音频条', picture: '显示画面' };
    await open(page, `&lang=${lang}`);
    const pip = await enter(page);
    await page.evaluate(() => {
      const w = window as unknown as { denied: unknown[] };
      w.denied = [];
      (window.player as Player).qoe.on('presentation-denied', (p) => void w.denied.push(p));
    });
    await pip.mouse.move(60, 60);
    await pip.mouse.move(70, 64);
    const slider = pip.getByRole('slider', { name: t.dim });
    const button = pip.getByRole('button', { name: `${t.dim} 40%` });
    // Closed until the button opens it.
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(slider).toBeHidden();
    expect(await pip.locator('otter-settings-menu').evaluate((el) => getComputedStyle(el).display)).toBe('none');
    await button.click();
    await expect(slider).toBeVisible();
    await expect(slider).toHaveAttribute('aria-valuetext', '40%');
    // A press near the right end of the track: the last step, 80 %; then keys step by one.
    const box = await pip.evaluate(() => {
      const r = (document.querySelector('.ot-track') as HTMLElement).getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await pip.mouse.click(box.x + box.w * 0.95, box.y + box.h / 2);
    await expect.poll(async () => (await state(page)).presentation.companion.dim).toBe(0.8);
    await slider.focus();
    await pip.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await state(page)).presentation.companion.dim).toBe(0.6);
    await pip.keyboard.press('Home');
    await expect.poll(async () => (await state(page)).presentation.companion.dim).toBe(0);
    await expect(slider).toHaveAttribute('aria-valuetext', '0%');
    // Escape closes it; the button now says the new step.
    await pip.keyboard.press('Escape');
    await expect(slider).toBeHidden();
    await expect(pip.getByRole('button', { name: `${t.dim} 0%` })).toBeFocused();
    // The audio strip and back, by click (the resize has its user activation: nothing refused).
    await pip.getByRole('button', { name: t.strip }).click();
    await expect.poll(async () => (await state(page)).presentation.companion.audioOnly).toBe(true);
    await expect(pip.getByRole('button', { name: t.picture })).toBeVisible();
    await pip.getByRole('button', { name: t.picture }).click();
    await expect.poll(async () => (await state(page)).presentation.companion.audioOnly).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { denied: unknown[] }).denied)).toEqual([]);
  });
}

test('axe: the companion window (idle, with its controls shown) and the strip have no serious or critical violations', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await open(page);
  const pip = await enter(page);
  const idle = await axeIn(pip, page, 'idle').analyze();
  await pip.mouse.move(60, 60);
  await pip.mouse.move(70, 64);
  await expect(pip.locator('.ot-dim-toggle')).toBeVisible();
  await pip.locator('.ot-dim-toggle').click();
  await expect(pip.locator('.ot-dim')).toBeVisible();
  const shown = await axeIn(pip, page, 'controls shown').analyze();
  await pip.keyboard.press('Escape');
  await pip.locator('.ot-strip').click();
  await expect.poll(async () => (await state(page)).presentation.companion.audioOnly).toBe(true);
  const strip = await axeIn(pip, page, 'audio strip').analyze();
  await testInfo.attach('axe-companion.json', { body: JSON.stringify({ idle, shown, strip }, null, 2), contentType: 'application/json' });
  // Each scan saw the window's content (rules that passed there), not an empty document.
  for (const r of [idle, shown, strip]) expect(r.passes.length).toBeGreaterThan(0);
  expect([...blocking(idle), ...blocking(shown), ...blocking(strip)]).toEqual([]);
});

// @solo (one worker, alone in its CI step, like the other sound checks): measured 2026-11-17 on a
// loaded machine (12 parallel runs, 12 busy processes), WebCodecs with sound underran as often
// without the window as with it (7 of 36 each; same signature as CI #297-#303: decode queue at 17,
// long main-thread tasks). The underruns on CI came from the main step's parallel load, not from
// companion mode.
test('WebCodecs: into the window and back without an audio underrun or a playhead jump @solo', async ({ page }) => {
  test.setTimeout(60_000);
  if (!JUDGED.includes(test.info().project.name)) {
    ciNotice('companion WebCodecs: judged on desktop-chrome and real Edge only (acceptance 8)');
    test.skip(true, 'judged on desktop-chrome and real Edge only');
  }
  // Diagnostics for a failure (CI #297 saw underruns here): main-thread long tasks in the page.
  await page.addInitScript(() => {
    const w = window as unknown as { longTasks: [number, number][] };
    w.longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto('/player.html?idle=0&companion=1');
  const fixture = () =>
    page.evaluate(async () => {
      const o = (await window.otter) as OtterFixture;
      const s = o.state();
      return { t: s.currentTime, paused: s.paused, backend: s.backend, mode: s.presentation.mode, active: s.presentation.companion.active, supported: s.presentation.companion.supported };
    });
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: await o.fetchBlob('/frames/h264-720p-av.mp4') }, { autoplay: true });
  });
  await expect.poll(async () => (await fixture()).t, { timeout: 30_000 }).toBeGreaterThan(0.5);
  expect((await fixture()).backend).toBe('webcodecs');
  if (!(await fixture()).supported) {
    ciNotice('companion WebCodecs: no Document PiP here');
    test.skip(true, 'no Document PiP');
  }
  await page.evaluate(() => {
    const w = window as unknown as { samples: { t: number; at: number; paused: boolean }[] };
    w.samples = [];
    const tick = async (): Promise<void> => {
      const s = ((await window.otter) as OtterFixture).state();
      w.samples.push({ t: s.currentTime, at: performance.now() / 1000, paused: s.paused });
      setTimeout(() => void tick(), 50);
    };
    void tick();
  });
  // A gesture-carrying dispatch (the fixture's narrow layout may hide the button).
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-pip', {}));
  await expect.poll(async () => (await fixture()).active, { timeout: 8000 }).toBe(true);
  await page.waitForTimeout(1500);
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('exit-presentation', {}));
  await expect.poll(async () => (await fixture()).mode).toBe('inline');
  await page.waitForTimeout(1000);
  const { samples, underruns, longTasks } = await page.evaluate(async () => ({
    longTasks: (window as unknown as { longTasks: [number, number][] }).longTasks,
    samples: (window as unknown as { samples: { t: number; at: number; paused: boolean }[] }).samples,
    underruns: ((await window.otter) as OtterFixture).events
      .filter((e) => e.type === 'error' && (e.payload as { error?: { details?: string } }).error?.details === 'audioUnderrun')
      .map((e) => (e.payload as { error: { message?: string } }).error.message ?? ''),
  }));
  // Hypothesis (CI #297, not verified): the page's timers, which feed the audio, are throttled
  // while the PiP window has the focus. The widest gap between the page's 50 ms samples says so.
  const gaps = samples.slice(1).map((x, i) => Math.round((x.at - (samples[i] as { at: number }).at) * 1000));
  const diagnostics = `widest gap between 50 ms page timer ticks: ${Math.max(0, ...gaps)} ms; long tasks (start, ms): ${JSON.stringify(longTasks.slice(-8))}`;
  ciNotice(`companion WebCodecs: ${diagnostics}`);
  expect(underruns, diagnostics).toEqual([]);
  expect(samples.every((x) => !x.paused)).toBe(true);
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as { t: number; at: number };
    const b = samples[i] as { t: number; at: number };
    expect(b.t, `sample ${i}`).toBeGreaterThanOrEqual(a.t);
    expect(b.t - a.t, `sample ${i}`).toBeLessThanOrEqual(b.at - a.at + 0.5);
  }
  ciNotice(`companion WebCodecs: in and out of the window, ${samples.length} samples, no underrun`);
});

/** Removes Document PiP before the page runs: Firefox and Safari as they ship (ADR-016 conflict 6). */
const withoutDocumentPip = (page: Page) =>
  page.addInitScript(() => {
    Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, get: () => undefined });
  });

test('without Document PiP: not supported, no settings page, the PiP button keeps its old rules, no error', async ({ page, browserName }) => {
  test.setTimeout(60_000);
  // Judged on desktop-firefox, desktop-safari and emulated-iphone (acceptance 6); the others have
  // the API removed as well, so the path is checked everywhere.
  await withoutDocumentPip(page);
  await page.goto(`/companion.html?src=${SRC}`);
  await expect.poll(async () => (await state(page)).status, { timeout: 20_000 }).toBe('ready');
  await page.evaluate(() => {
    const w = window as unknown as { errors: unknown[]; denied: unknown[] };
    w.errors = [];
    w.denied = [];
    (window.player as Player).qoe.on('error', (p) => void w.errors.push(p));
    (window.player as Player).qoe.on('presentation-denied', (p) => void w.denied.push(p));
  });
  const s = await state(page);
  expect(s.presentation.capabilities.docpip).toBe(false);
  expect(s.presentation.companion).toMatchObject({ supported: false, active: false });
  // No companion page in the settings menu.
  await page.locator('otter-settings-menu').getByRole('button').first().click();
  await expect(page.getByRole('menuitem', { name: /^Captions|^字幕|^Quality|^清晰度/ }).first()).toBeVisible();
  expect(await page.getByRole('menuitem', { name: /^Floating player|^悬浮窗/ }).count()).toBe(0);
  await page.keyboard.press('Escape');
  // The PiP button: video PiP (the picture only), or the browser's refusal where it has the API but
  // will not open a window (headless WebKit, RESEARCH §1), or nothing where there is no PiP at all.
  const pip = page.locator('otter-pip-button');
  if (s.presentation.capabilities.pip === false) {
    expect(await pip.evaluate((el) => el.hasAttribute('data-otter-unsupported'))).toBe(true);
    ciNotice('companion fallback: no PiP of any kind here; the button is hidden');
  } else {
    await page.addStyleTag({ content: 'otter-pip-button { display: inline-block !important; }' });
    await pip.getByRole('button').click();
    await expect.poll(async () => (await state(page)).presentation.pending === null && ((await state(page)).presentation.mode === 'pip' || (await page.evaluate(() => (window as unknown as { denied: unknown[] }).denied.length)) > 0), { timeout: 8000 }).toBe(true);
    const mode = (await state(page)).presentation.mode;
    if (mode === 'pip') ciNotice('companion fallback: video PiP entered');
    else {
      expect(browserName, 'only WebKit refuses to open a video PiP window here').toBe('webkit');
      ciNotice('companion fallback: video PiP refused by the browser (rolled back)');
    }
  }
  expect(await page.evaluate(() => (window as unknown as { errors: unknown[] }).errors)).toEqual([]);
  expect((await state(page)).presentation.companion.active).toBe(false);
});

test('in an iframe: companion mode is not supported', async ({ page }) => {
  test.setTimeout(30_000);
  test.skip(!JUDGED.includes(test.info().project.name), 'checked where Document PiP exists at the top level');
  await page.goto('/index.html');
  await page.setContent(`<iframe src="/companion.html?src=${SRC}" style="width:960px;height:540px"></iframe>`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-otter-player]')).toHaveCount(1);
  const inner = page.frames().find((f) => f.url().includes('companion.html'));
  if (inner === undefined) throw new Error('no iframe');
  await expect.poll(() => inner.evaluate(() => window.player?.store.getState().status), { timeout: 20_000 }).toBe('ready');
  const companion = await inner.evaluate(() => (window.player as Player).store.getState().presentation);
  expect(companion.capabilities.docpip).toBe(false);
  expect(companion.companion.supported).toBe(false);
});
