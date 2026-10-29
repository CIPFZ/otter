// axe scan (SPEC §1.1 / §14.5: WCAG 2.2 AA). Serious and critical violations fail the run; the
// full result is attached to the report.

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('fixture page has no serious or critical axe violations', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Ready');

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  await testInfo.attach('axe-results.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });

  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.help} [${v.nodes.map((n) => n.target.join(' ')).join(', ')}]`);
  expect(blocking).toEqual([]);
});

// ------------------------------------------------------------------------------------------------
// M2 acceptance (ADR-005 §6): the full control set on the player page.


const blockingOf = (results: Awaited<ReturnType<AxeBuilder['analyze']>>): string[] =>
  results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.help} [${v.nodes.map((n) => n.target.join(' ')).join(', ')}]`);

async function loadPlayer(page: Page, query = ''): Promise<void> {
  // idle=0: controls stay up for the scan and the Tab walk.
  await page.goto(`/player.html?idle=0${query}`);
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/hls-fmp4/master.m3u8', textTracks: [{ src: '/subs/sidecar.vtt', language: 'en', label: 'English' }] }, { autoplay: true });
  });
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().qoe.ttff), { timeout: 30_000 }).not.toBeNull();
}

for (const lang of ['en', 'zh-CN'] as const) {
test(`player page${lang === 'en' ? '' : ' in Chinese (lang=zh-CN)'}: no serious or critical axe violations while playing, with captions and the settings menu open`, async ({ page }, testInfo) => {
  await loadPlayer(page, lang === 'en' ? '' : '&lang=zh-CN');
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('select-text-track', { id: 'sidecar:0' }));
  const playing = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  await page.locator('otter-settings-menu').locator('button').click();
  await expect(page.getByRole('menu')).toBeVisible();
  const menu = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  await testInfo.attach('axe-player.json', { body: JSON.stringify({ playing, menu }, null, 2), contentType: 'application/json' });
  expect([...blockingOf(playing), ...blockingOf(menu)]).toEqual([]);
});
}

test('every control is reachable with Tab and shows a visible focus ring', async ({ page, browserName }, testInfo) => {
  test.skip(browserName === 'webkit', 'WebKit only tabs to links/buttons with "Press Tab to highlight each item" enabled');
  await loadPlayer(page);
  await page.locator('h1').click();
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      let el: Element | null = document.activeElement;
      const host = el;
      while (el?.shadowRoot?.activeElement != null) el = el.shadowRoot.activeElement;
      if (el === null || !(document.getElementById('player') as HTMLElement).contains(host)) return null;
      const cs = getComputedStyle(el);
      return {
        name: `${host?.tagName.toLowerCase()}:${el.getAttribute('aria-label') ?? el.getAttribute('role') ?? el.tagName.toLowerCase()}`,
        outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
      };
    });
    if (info === null) {
      if (seen.length > 0) break;
      continue;
    }
    seen.push(info.name);
    expect(info.outline, `${info.name} has a visible focus ring`).toBe(true);
    await testInfo.attach(`focus-${seen.length}-${info.name.replace(/[^a-z0-9]+/gi, '-')}.png`, { body: await page.locator('#player').screenshot(), contentType: 'image/png' });
  }
  // Inline player: Tab leaves the player after the last control (no keyboard trap).
  // The skin hides the volume slider on touch screens (hardware volume keys).
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  const required = ['otter-play-button', 'otter-mute-button', ...(coarse ? [] : ['otter-volume-slider']), 'otter-time-slider', 'otter-captions-button', 'otter-settings-menu', 'otter-fullscreen-button'];
  for (const tag of required) {
    expect(seen.some((s) => s.startsWith(`${tag}:`)), `${tag} reachable (seen: ${seen.join(', ')})`).toBe(true);
  }
});

test('keyboard: space / k / m / c / arrows act on the player; the menu takes arrows and Escape', async ({ page }) => {
  await loadPlayer(page);
  const state = () => page.evaluate(async () => ((await window.otter) as OtterFixture).state());
  await page.locator('#player').focus();
  const wasPaused = (await state()).paused;
  await page.keyboard.press('k');
  await expect.poll(async () => (await state()).paused).toBe(!wasPaused);
  await page.keyboard.press('m');
  await expect.poll(async () => (await state()).muted).toBe(false);
  await page.keyboard.press('c');
  await expect.poll(async () => (await state()).textTrack).toBe('sidecar:0');
  await page.keyboard.press('c');
  await expect.poll(async () => (await state()).textTrack).toBeNull();

  // Settings: ArrowDown opens at the checked item; arrows stay in the menu; Escape closes it and
  // returns focus to the trigger.
  const trigger = page.locator('otter-settings-menu').locator('button');
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu')).toBeVisible();
  const before = (await state()).currentTime;
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(trigger).toBeFocused();
  // The arrow moved inside the menu instead of seeking.
  expect(Math.abs((await state()).currentTime - before)).toBeLessThan(5);
  await page.keyboard.press('ArrowDown');
  await page.getByRole('menuitemradio', { name: '1.5x' }).press('Enter');
  await expect.poll(async () => (await state()).playbackRate).toBe(1.5);
});

test('sliders keep a 24 px target (WCAG 2.5.8) with the thumb drawn inside it', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('emulated'), 'phones hide the volume slider');
  await page.goto('/player.html?idle=0');
  for (const tag of ['otter-time-slider', 'otter-volume-slider']) {
    const box = await page.locator(tag).first().evaluate((el) => {
      (el as HTMLElement).style.setProperty('--otter-volume-width', '72px');
      const input = el.shadowRoot?.querySelector('input') as HTMLInputElement;
      const r = input.getBoundingClientRect();
      const cs = getComputedStyle(input);
      return { h: r.height, thumb: parseFloat(cs.getPropertyValue('--otter-thumb')) || 13 };
    });
    expect(box.h, `${tag} target height`).toBeGreaterThanOrEqual(24);
    // Centred in the target (visual.spec measures it from pixels): (24 - thumb) / 2 on each side.
    expect(box.thumb).toBeLessThanOrEqual(box.h);
  }
});
