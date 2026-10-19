// UI review screenshots (UI-DESIGN §11.1). Opt-in: OTTER_SCREENSHOTS=1 writes
// docs/reports/m2.5/<project>-<n>-<state>.png, OTTER_SCREENSHOTS=m3 docs/reports/m3/ from the same
// camera positions plus the M3 controls; normal runs skip this file.

import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const mode = process.env['OTTER_SCREENSHOTS'];
test.skip(mode !== '1' && mode !== 'm3', 'set OTTER_SCREENSHOTS=1 (M2.5) or m3 to refresh the review screenshots');
const m3 = mode === 'm3';

test('review screenshots', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const out = (n: string): string => `docs/reports/${m3 ? 'm3' : 'm2.5'}/${testInfo.project.name}-${n}.png`;
  const state = () => page.evaluate(async () => ((await window.otter) as OtterFixture).state());
  await page.goto('/player.html?idle=0');
  const player = page.locator('#player');
  await page.evaluate(async (m3) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    // M3: the preview card shows sprite thumbnails (same clip, same positions otherwise).
    o.load(m3 ? { src: '/demo/master.m3u8', thumbnails: { src: '/demo/thumbs.vtt' } } : { src: '/demo/master.m3u8' });
  }, m3);
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
  await page.waitForTimeout(m3 ? 800 : 300);
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

  if (!m3) return;
  await page.evaluate(() => ((document.querySelector('otter-stats') as HTMLElement).hidden = true));

  // 6: live behind the edge -> "Back to live" capsule.
  await page.evaluate(async () => ((await window.otter) as OtterFixture).load({ src: '/live/stream.flv', live: true }, { autoplay: true }));
  await expect.poll(async () => (await state()).currentTime, { timeout: 20_000 }).toBeGreaterThan(0.5);
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
  await expect(page.locator('otter-live-indicator').getByRole('button')).toBeVisible({ timeout: 15_000 });
  await page.mouse.move(bar.x + bar.width * 0.4, bar.y - 200);
  await page.waitForTimeout(300);
  await player.screenshot({ path: out('6-back-to-live') });

  // 7: theater (the host widens the player), whole page.
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.load({ src: '/demo/master.m3u8', thumbnails: { src: '/demo/thumbs.vtt' } });
  });
  await expect.poll(async () => (await state()).status).toBe('ready');
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-theater', {}));
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('7-theater'), fullPage: true });
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-theater', {}));

  // 8: page mini window in the corner, page scrolled.
  await page.evaluate(() => document.body.setAttribute('data-scroll', ''));
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-mini', {}));
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('8-mini') });
});
