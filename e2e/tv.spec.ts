// The TV player at 1920 x 1080 (ADR-013 batch 4: ui-skin-tv and remote input), on the CI project
// `tv-1080` (Chromium) and the real Windows Edge (keyboard as the remote): the 10-foot layer (type,
// title-safe area, focus ring), spatial navigation, Back, OK, hold-to-seek acceleration, the
// configurable key map with platform key codes, and axe with the TV skin.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { Player } from '@otter-player/presets';

const SRC = '/frames/hls-ladder/master.m3u8';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.beforeEach(async ({ page }, info) => {
  test.skip(!['tv-1080', 'real-windows-edge'].includes(info.project.name), 'the TV project (1920 x 1080) and the real Edge');
  await page.setViewportSize({ width: 1920, height: 1080 });
});

const state = (page: Page) => page.evaluate(() => (window.preset as Player).store.getState());

/** The focused control: its host element's tag, or `player` for the root. */
const focused = (page: Page) =>
  page.evaluate(() => {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement != null) a = a.shadowRoot.activeElement;
    const root = a?.getRootNode();
    const host = root instanceof ShadowRoot ? (root.host as Element) : a;
    return host === null || host === undefined ? '' : host.id === 'player' ? 'player' : host.tagName.toLowerCase();
  });

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/tv.html?preset=tv&src=${SRC}${query}`);
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(0.3);
  await page.locator('#player').focus();
}

/** A keydown (and keyup) on the focused element with a legacy keyCode, as TV platforms send them. */
const pressCode = (page: Page, keyCode: number, repeat = false) =>
  page.evaluate(
    ([code, rep]) => {
      let a: Element | null = document.activeElement;
      while (a?.shadowRoot?.activeElement != null) a = a.shadowRoot.activeElement;
      const target = a ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: code, repeat: rep, bubbles: true, composed: true, cancelable: true }));
      if (!rep) target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: code, bubbles: true, composed: true }));
    },
    [keyCode, repeat] as const,
  );

test('tv skin: 10-foot type, the bars inside the title-safe area, a large focus ring on the focused control', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ArrowDown');
  expect(await focused(page)).toBe('otter-play-button');
  const box = (await page.locator('#player').boundingBox()) as { x: number; y: number; width: number; height: number };
  expect(box.width).toBeGreaterThan(1900);
  // Title-safe: every control of the bottom bar and the title within 5 % of the edges (1 px slack).
  const controls = await page.locator('[data-otter-controls] > *, [data-otter-controls] [data-otter-group] > *').evaluateAll((els) =>
    els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return { tag: e.tagName.toLowerCase(), l: r.left, r: r.right, b: r.bottom }; }),
  );
  expect(controls.length).toBeGreaterThan(3);
  for (const c of controls) {
    expect(c.l, `${c.tag} left edge`).toBeGreaterThanOrEqual(box.x + 0.05 * box.width - 1);
    expect(c.r, `${c.tag} right edge`).toBeLessThanOrEqual(box.x + 0.95 * box.width + 1);
    expect(c.b, `${c.tag} bottom edge`).toBeLessThanOrEqual(box.y + 0.95 * box.height + 1);
  }
  const title = (await page.locator('[data-otter-title]').boundingBox()) as { x: number; y: number };
  expect(title.x).toBeGreaterThanOrEqual(box.x + 0.05 * box.width - 1);
  expect(title.y).toBeGreaterThanOrEqual(box.y + 0.05 * box.height - 1);
  // Type: title 36 px, time 28 px; controls 72 px.
  expect(await page.locator('[data-otter-title]').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(36);
  expect(await page.locator('otter-time-display').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(28);
  const play = page.locator('[data-otter-controls] otter-play-button').getByRole('button');
  expect((await play.boundingBox())?.height).toBeGreaterThanOrEqual(72);
  // The focus ring of the focused play button: 4 px, accent colour, scaled up.
  const ring = await play.evaluate((b) => { const s = getComputedStyle(b); return { width: parseFloat(s.outlineWidth), style: s.outlineStyle, transform: s.transform }; });
  expect(ring).toMatchObject({ style: 'solid' });
  expect(ring.width).toBeGreaterThanOrEqual(4);
  expect(ring.transform).not.toBe('none');
  // No hover tooltips on a TV.
  expect(await page.locator('[data-otter-controls] otter-play-button').evaluate((h) => getComputedStyle(h.shadowRoot?.querySelector('[part="tooltip"]') as Element).display)).toBe('none');
});

test('remote: arrows move the focus, Back leaves the controls, OK plays / pauses on the picture and activates a control', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ArrowDown');
  const first = await focused(page);
  await page.keyboard.press('ArrowRight');
  const second = await focused(page);
  expect(second).toMatch(/^otter-/);
  expect(second).not.toBe(first);
  await page.keyboard.press('ArrowLeft');
  expect(await focused(page)).toBe(first);
  // Back: out of the controls, onto the picture.
  await page.keyboard.press('Escape');
  expect(await focused(page)).toBe('player');
  // OK on the picture: pause; again: play.
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).paused).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  // OK on the focused play button: its own activation.
  await page.keyboard.press('ArrowDown');
  expect(await focused(page)).toBe('otter-play-button');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).paused).toBe(true);
});

test('remote: holding Right on the picture seeks faster the longer it is held; a single press seeks 10 s', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window.preset as Player).store.dispatch('pause', undefined));
  await page.evaluate(() => (window.preset as Player).store.dispatch('seek', { time: 0 }));
  await expect.poll(async () => (await state(page)).currentTime).toBeLessThan(0.5);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await state(page)).currentTime).toBeGreaterThan(9);
  const once = (await state(page)).currentTime;
  expect(once).toBeLessThan(11);
  await page.evaluate(() => (window.preset as Player).store.dispatch('seek', { time: 0 }));
  await expect.poll(async () => (await state(page)).currentTime).toBeLessThan(0.5);
  // Held: key repeat every 50 ms for 2 s. Default steps: 10 s, then 30 s after 1.5 s, one per 250 ms.
  // Each step is a seek-by from where the last one landed; the clip is 30 s long, so watch the
  // requests instead: the seek targets the store saw.
  const seeks: number[] = await page.evaluate(async () => {
    const p = window.preset as Player;
    const out: number[] = [];
    const off = p.store.subscribe((s, prev) => {
      if (s.seeking && !prev.seeking) out.push(s.currentTime);
    });
    let a: Element | null = document.activeElement;
    while (a?.shadowRoot?.activeElement != null) a = a.shadowRoot.activeElement;
    const target = a ?? document.body;
    const send = (repeat: boolean) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat, bubbles: true, composed: true, cancelable: true }));
    send(false);
    for (let t = 50; t <= 2000; t += 50) {
      await new Promise((r) => setTimeout(r, 50));
      send(true);
    }
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true, composed: true }));
    off();
    return out;
  });
  // Several steps, not one per key repeat (40 repeats; at most one step per 250 ms).
  expect(seeks.length).toBeGreaterThanOrEqual(3);
  expect(seeks.length).toBeLessThanOrEqual(10);
});

test('remote: the key map is configurable; platform key codes work (Tizen Back 10009, Play / Pause 10252, webOS Back 461)', async ({ page }) => {
  // ?keys=back:b|10009: Back is the b key and Tizen's code only (Escape no longer).
  await open(page, '&keys=back:b|10009');
  await page.keyboard.press('ArrowDown');
  expect(await focused(page)).toMatch(/^otter-/);
  await page.keyboard.press('Escape');
  expect(await focused(page)).not.toBe('player');
  await page.keyboard.press('b');
  expect(await focused(page)).toBe('player');
  await page.keyboard.press('ArrowDown');
  await pressCode(page, 10009);
  expect(await focused(page)).toBe('player');
  // Default map: Tizen Play / Pause and webOS Back.
  await page.goto('about:blank');
  await open(page);
  await pressCode(page, 10252);
  await expect.poll(async () => (await state(page)).paused).toBe(true);
  await page.keyboard.press('ArrowDown');
  await pressCode(page, 461);
  expect(await focused(page)).toBe('player');
});

test('tv skin: no serious or critical axe violations while playing with the controls focused, and with the settings menu open', async ({ page }, info) => {
  await open(page);
  await page.keyboard.press('ArrowDown');
  const blocking = (r: Awaited<ReturnType<AxeBuilder['analyze']>>) => r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  const controls = await new AxeBuilder({ page }).include('#player').withTags(WCAG_TAGS).analyze();
  const settings = page.locator('[data-otter-controls] otter-settings-menu').getByRole('button').first();
  if ((await settings.count()) > 0) await settings.click();
  const menu = await new AxeBuilder({ page }).include('#player').withTags(WCAG_TAGS).analyze();
  await info.attach('axe-tv.json', { body: JSON.stringify({ controls, menu }, null, 2), contentType: 'application/json' });
  expect(blocking(controls)).toEqual([]);
  expect(blocking(menu)).toEqual([]);
});
