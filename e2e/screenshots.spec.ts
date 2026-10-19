// UI review screenshots for docs/reports/M2.5.md (UI-DESIGN §11.1). Opt-in: OTTER_SCREENSHOTS=1
// writes docs/reports/m2.5/<project>-<n>-<state>.png; normal runs skip this file.

import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

test.skip(process.env['OTTER_SCREENSHOTS'] !== '1', 'set OTTER_SCREENSHOTS=1 to refresh the review screenshots');

test('M2.5 review screenshots', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const out = (n: string): string => `docs/reports/m2.5/${testInfo.project.name}-${n}.png`;
  const state = () => page.evaluate(async () => ((await window.otter) as OtterFixture).state());
  await page.goto('/player.html?idle=0');
  const player = page.locator('#player');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/demo/master.m3u8' });
  });
  await expect.poll(async () => (await state()).status).toBe('ready');
  await page.waitForTimeout(800);
  await player.screenshot({ path: out('1-poster') });

  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('play', undefined));
  await expect.poll(async () => (await state()).textTracks.length).toBeGreaterThan(0);
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('select-text-track', { id: 'inband:text-0' }));
  await expect.poll(async () => (await state()).currentTime, { timeout: 15_000 }).toBeGreaterThan(3);
  await page.waitForFunction(() => document.querySelector('[data-cue-id]') !== null);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  await player.screenshot({ path: out('2-playing') });

  const bar = (await page.locator('otter-time-slider').boundingBox())!;
  await page.mouse.move(bar.x + bar.width * 0.7, bar.y + bar.height / 2);
  await page.waitForTimeout(300);
  await player.screenshot({ path: out('3-hover-progress') });

  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
  await page.mouse.move(bar.x + bar.width * 0.4, bar.y - 200);
  await page.locator('otter-settings-menu').locator('button').first().click();
  await page.waitForTimeout(300);
  await player.screenshot({ path: out('4a-menu-level1') });
  await page.getByRole('menuitem', { name: /^Quality/ }).click();
  await page.waitForTimeout(300);
  await player.screenshot({ path: out('4b-menu-level2') });
  await page.keyboard.press('Escape');

  await page.evaluate(() => ((document.querySelector('otter-stats') as HTMLElement).hidden = false));
  await page.locator('h1').click();
  await page.mouse.move(bar.x + bar.width * 0.4, bar.y - 200);
  await page.waitForTimeout(500);
  await player.screenshot({ path: out('5-stats') });
});
