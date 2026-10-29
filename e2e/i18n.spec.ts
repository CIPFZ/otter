// The controls' language (ADR-005 §6, M6 i18n): a preset's `lang` option, else the page's nearest
// `lang`, else the browser's language. Every control of the bar and the centre speaks it.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { Player } from '@otter-player/presets';

const CJK = /[㐀-鿿]/;

/** aria-label of every visible control (inside the elements' shadow roots) in the player. */
const labels = (page: Page) =>
  page.evaluate(() => {
    const out: { tag: string; label: string }[] = [];
    const player = document.getElementById('player') as HTMLElement;
    for (const el of player.querySelectorAll('[data-otter-controls] *, [data-otter-center] *')) {
      if (!el.localName.startsWith('otter-') || el.hasAttribute('data-otter-unsupported') || el.hasAttribute('hidden')) continue;
      const control = el.shadowRoot?.querySelector('button, input, [role="button"]');
      if (control === null || control === undefined) continue;
      const box = (el as HTMLElement).getBoundingClientRect();
      if (box.width === 0 && box.height === 0 && getComputedStyle(el).display === 'none') continue;
      out.push({ tag: el.localName, label: control.getAttribute('aria-label') ?? '' });
    }
    return { region: player.getAttribute('aria-label') ?? '', controls: out };
  });

async function ready(page: Page, query: string): Promise<void> {
  await page.goto(`/presets.html?preset=vod&src=/hls-fmp4/master.m3u8${query}`);
  await expect.poll(async () => page.evaluate(() => (window.preset as Player).store.getState().status), { timeout: 15_000 }).toBe('ready');
}

test('lang=zh-CN (preset option): the region and every control of the bar are labelled in Chinese', async ({ page }) => {
  await ready(page, '&lang=zh-CN');
  const l = await labels(page);
  expect(l.region).toBe('视频播放器');
  expect(l.controls.length).toBeGreaterThan(5);
  // Brand names stay as they are (AirPlay); every other label carries Chinese.
  for (const c of l.controls.filter((x) => x.tag !== 'otter-airplay-button')) expect(c.label, c.tag).toMatch(CJK);
  // The progress bar speaks its position in Chinese too.
  const valuetext = await page.locator('otter-time-slider').first().evaluate((el) => el.shadowRoot?.querySelector('input')?.getAttribute('aria-valuetext') ?? '');
  expect(valuetext).toMatch(/秒/);
});

test.describe('browser language zh-CN, no lang on the page', () => {
  test.use({ locale: 'zh-CN' });
  test('the controls follow navigator.language', async ({ page }) => {
    await ready(page, '');
    expect(await page.evaluate(() => [navigator.language, document.documentElement.lang])).toEqual(['zh-CN', '']);
    const l = await labels(page);
    expect(l.region).toBe('视频播放器');
    for (const c of l.controls.filter((x) => x.tag !== 'otter-airplay-button')) expect(c.label, c.tag).toMatch(CJK);
  });
});

test.describe('browser language en-US, no lang on the page', () => {
  test.use({ locale: 'en-US' });
  test('the controls stay English; lang=zh-CN on the player still wins', async ({ page }) => {
    await ready(page, '');
    const l = await labels(page);
    expect(l.region).toBe('Video player');
    for (const c of l.controls) expect(c.label, c.tag).not.toMatch(CJK);
    await ready(page, '&lang=zh-CN');
    expect((await labels(page)).region).toBe('视频播放器');
  });
});
