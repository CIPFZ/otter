// One tab with sound (SPEC §15 外部窗口 / 多标签, ADR-008 §8): two players of the origin on one
// BroadcastChannel; the one that starts playing with sound later mutes the earlier, which reports
// a QoE `audio-yield`; pausing or closing the later one gives nothing back.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const state = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const s = o.state();
    return { paused: s.paused, muted: s.muted, t: s.currentTime, yields: o.events.filter((e) => e.type === 'audio-yield').length };
  });

/** Loads the progressive MP4 (sound) and plays it unmuted. */
async function play(page: Page): Promise<void> {
  await page.goto('/player.html?idle=0');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: false });
    o.load({ src: '/vod/progressive.mp4' }, { autoplay: false });
  });
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().status), { timeout: 20_000 }).toBe('ready');
  // A real click: playing with sound needs a user gesture in some engines.
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect.poll(async () => (await state(page)).t, { timeout: 15_000 }).toBeGreaterThan(0.2);
}

test('a later tab playing with sound mutes the earlier one; nothing comes back on pause or close', async ({ page }) => {
  test.setTimeout(60_000);
  await play(page);
  expect(await state(page)).toMatchObject({ paused: false, muted: false, yields: 0 });

  const later = await page.context().newPage();
  await play(later);
  // The earlier tab muted itself (still playing) and reported it; the later one keeps its sound.
  await expect.poll(async () => (await state(page)).muted).toBe(true);
  expect(await state(page)).toMatchObject({ paused: false, yields: 1 });
  expect(await state(later)).toMatchObject({ paused: false, muted: false, yields: 0 });

  // Pausing, then closing the later tab: the earlier one stays muted.
  await later.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
  await later.close();
  await page.waitForTimeout(500);
  expect(await state(page)).toMatchObject({ paused: false, muted: true, yields: 1 });

  // Unmuting there takes the sound back (a new start with sound); a muted second tab is not touched.
  const silent = await page.context().newPage();
  await silent.goto('/player.html?idle=0');
  await silent.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/vod/progressive.mp4' }, { autoplay: true });
  });
  await expect.poll(async () => (await state(silent)).t, { timeout: 15_000 }).toBeGreaterThan(0.2);
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('set-muted', { muted: false }));
  await page.waitForTimeout(500);
  expect(await state(page)).toMatchObject({ muted: false, yields: 1 });
  expect(await state(silent)).toMatchObject({ paused: false, muted: true, yields: 0 });
});
