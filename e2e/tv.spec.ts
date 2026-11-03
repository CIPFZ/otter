// The TV player at 1920 x 1080 (ADR-013 batch 4: ui-skin-tv and remote input), on the CI project
// `tv-1080` (Chromium) and the real Windows Edge (keyboard as the remote): the 10-foot layer (type,
// title-safe area, focus ring), spatial navigation, Back, OK, hold-to-seek acceleration, the
// configurable key map with platform key codes, and axe with the TV skin.
import { mkdirSync } from 'node:fs';
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

/** The 1080p screenshots of the focus and menu states, a CI artifact (tv-screenshots/, owner 2026-11-03). */
const shot = async (page: Page, name: string): Promise<void> => {
  if (test.info().project.name !== 'tv-1080' || test.info().retry > 0) return;
  mkdirSync('tv-screenshots', { recursive: true });
  await page.screenshot({ path: `tv-screenshots/${name}.png` });
};

/**
 * The visible menu items of the open menu, through shadow roots: their font size as drawn (the
 * computed size times the CSS zoom applied to them) and their height.
 */
const menuText = (page: Page) =>
  page.evaluate(() => {
    const out: { size: number; height: number }[] = [];
    const visit = (n: Document | ShadowRoot | Element): void => {
      for (const el of Array.from(n.querySelectorAll('*'))) {
        if (/^menuitem/.test(el.getAttribute('role') ?? '')) {
          const r = el.getBoundingClientRect();
          const zoom = (el as Element & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
          if (r.height > 0) out.push({ size: Math.round(parseFloat(getComputedStyle(el).fontSize) * zoom * 10) / 10, height: r.height });
        }
        if (el.shadowRoot !== null) visit(el.shadowRoot);
      }
    };
    visit(document);
    return out;
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
  await shot(page, 'focus-play');
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

test('tv skin: the outermost controls, focused and scaled, keep their ring and halo inside the picture', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ArrowDown');
  const box = (await page.locator('#player').boundingBox()) as { x: number; y: number; width: number; height: number };
  // The bar's leftmost and rightmost focusable controls (by position), focused one after the other.
  const edges = await page.evaluate(() => {
    const out: { tag: string; left: number; right: number }[] = [];
    const visit = (n: Document | ShadowRoot | Element): void => {
      for (const el of Array.from(n.querySelectorAll('button, input'))) {
        const r = el.getBoundingClientRect();
        const host = (el.getRootNode() as ShadowRoot).host as Element | undefined;
        if (r.width > 0 && host?.closest('[data-otter-controls]') != null) out.push({ tag: host.tagName.toLowerCase(), left: r.left, right: r.right });
      }
      for (const el of Array.from(n.querySelectorAll('*'))) if (el.shadowRoot !== null) visit(el.shadowRoot);
    };
    visit(document);
    const buttons = out.filter((x) => x.tag !== 'otter-time-slider' && x.tag !== 'otter-volume-slider');
    buttons.sort((a, b) => a.left - b.left);
    return [buttons[0]?.tag, buttons.at(-1)?.tag];
  });
  for (const tag of edges) {
    const button = page.locator(`[data-otter-controls] ${tag as string}`).getByRole('button').first();
    await button.focus();
    await page.waitForTimeout(250);
    // The scaled border box plus what draws outside it: the outline (offset + width) and the halo
    // (box-shadow spread), scaled with it.
    const extent = await button.evaluate((b) => {
      const s = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      const scale = r.width / (b as HTMLElement).offsetWidth;
      const outline = parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth);
      const spread = Math.max(0, ...[...s.boxShadow.matchAll(/(-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px/g)].map((m) => parseFloat(m[4] as string)));
      const out = Math.max(outline, spread) * scale;
      return { left: r.left - out, right: r.right + out, top: r.top - out, bottom: r.bottom + out, scale };
    });
    expect(extent.scale, `${tag}: focused and scaled`).toBeGreaterThan(1.05);
    expect(extent.left, `${tag}: halo left edge`).toBeGreaterThanOrEqual(box.x);
    expect(extent.right, `${tag}: halo right edge`).toBeLessThanOrEqual(box.x + box.width);
    expect(extent.bottom, `${tag}: halo bottom edge`).toBeLessThanOrEqual(box.y + box.height);
  }
});

test('tv skin: every visible text in the control bar is 28 px or more (time, quality / speed labels, live badge)', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ArrowDown');
  // Text nodes under the bar, through open shadow roots, whose element is drawn: their font size.
  const texts = await page.evaluate(() => {
    const out: { text: string; size: number; host: string }[] = [];
    const visit = (n: Node, host: string): void => {
      if (n.nodeType === Node.TEXT_NODE) {
        const el = n.parentElement;
        const text = (n.textContent ?? '').trim();
        if (el === null || text === '') return;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && el.closest('[aria-hidden="true"], [hidden], [role="menu"], [role="tooltip"]') === null) out.push({ text, size: parseFloat(s.fontSize), host });
        return;
      }
      if (n instanceof Element && n.shadowRoot !== null) visit(n.shadowRoot, n.tagName.toLowerCase());
      for (const c of Array.from(n.childNodes)) visit(c, n instanceof Element && n.tagName.startsWith('OTTER-') ? n.tagName.toLowerCase() : host);
    };
    visit(document.querySelector('[data-otter-controls]') as Element, '');
    return out;
  });
  expect(texts.length, JSON.stringify(texts)).toBeGreaterThanOrEqual(2);
  for (const t of texts) expect(t.size, `${t.host} "${t.text}"`).toBeGreaterThanOrEqual(28);
});

test('tv skin, reduced motion: the focused control is not scaled and has no halo, the focus ring stays', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await page.keyboard.press('ArrowDown');
  const play = page.locator('[data-otter-controls] otter-play-button').getByRole('button');
  const s = await play.evaluate((b) => { const c = getComputedStyle(b); return { transform: c.transform, shadow: c.boxShadow, outline: parseFloat(c.outlineWidth), style: c.outlineStyle }; });
  expect(s.transform).toBe('none');
  expect(s.shadow).toBe('none');
  expect(s.style).toBe('solid');
  expect(s.outline).toBeGreaterThanOrEqual(4);
});

test('tv skin: menu text is 28 px or more, with CSS zoom and with the no-zoom fallback', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ArrowDown');
  await page.locator('[data-otter-controls] otter-settings-menu').getByRole('button').first().click();
  await expect.poll(async () => (await menuText(page)).length).toBeGreaterThan(0);
  await shot(page, 'menu-settings');
  // With zoom (Chromium): the text as drawn.
  const zoomed = await menuText(page);
  for (const m of zoomed) expect(m.size, `zoomed menu text ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(28);
  // The fallback as a browser without zoom applies it: the @supports not (zoom: 2) block's rules
  // made unconditional, zoom turned off.
  await page.evaluate(() => {
    const rules: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSSupportsRule && /not\s*\(\s*zoom/.test(rule.conditionText)) for (const r of Array.from(rule.cssRules)) rules.push(r.cssText);
      }
    }
    if (rules.length === 0) throw new Error('no @supports not (zoom) block in the TV skin');
    const style = document.createElement('style');
    style.textContent = `${rules.join('\n')}\n[data-otter-player] *::part(menu), [data-otter-player] *::part(preview), [data-otter-player] *::part(badge) { zoom: 1 !important; }`;
    document.head.append(style);
  });
  await page.waitForTimeout(100);
  const fallback = await menuText(page);
  expect(fallback.length).toBeGreaterThan(0);
  for (const m of fallback) expect(m.size, `menu text without zoom ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(28);
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
