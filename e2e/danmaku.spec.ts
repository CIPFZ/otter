// Danmaku (SPEC §13.2, ADR-012), batch 4 item 1: the engine's timeline is media time. B站 XML
// (e2e/media/danmaku/ladder.xml, generate-danmaku.py: one comment every 0.5 s over the 30 s
// numbered ladder) on the own HLS engine. Checked against the <video> element's currentTime:
// - a scrolling comment's x is the function of media time it should be (the formula, ±1 px);
// - pause freezes the stage (same picture after wall time passes); 2x moves it twice as fast;
// - a seek rebuilds the stage at the new time (what is in flight there, nothing later);
// - a hidden page draws nothing;
// - the settings page changes opacity / hides a type; with preferences the settings survive a reload.

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const otter = (page: Page) => page.evaluate(async () => ((await window.otter) as OtterFixture).state());
const inspect = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const d = o.danmaku();
    if (d === null) throw new Error('no danmaku');
    return { ...d, currentTime: (document.querySelector('video') as HTMLVideoElement).currentTime };
  });

async function start(page: Page, query = ''): Promise<void> {
  await page.goto(`/player.html?idle=0&danmaku=1${query}`);
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/frames/hls-ladder/master.m3u8' }, { autoplay: true });
    o.dispatch('load-danmaku', { url: '/danmaku/ladder.xml' });
  });
  await expect.poll(async () => (await otter(page)).danmakuStatus, { timeout: 15_000 }).toMatchObject({ status: 'ready', count: 60, skipped: 3, renderer: 'canvas2d' });
}

const dispatch = (page: Page, type: string, payload: unknown) =>
  page.evaluate(async ([t, p]) => ((await window.otter) as OtterFixture).dispatch(t as 'pause', p as undefined), [type, payload] as const);

/** Every scrolling comment where media time says it is (stage px, ±1). */
function checkPositions(d: Awaited<ReturnType<typeof inspect>>): number {
  let n = 0;
  for (const c of d.running) {
    if (c.mode !== 'rtl' && c.mode !== 'ltr') continue;
    const elapsed = ((d.stage.width + c.width) * (d.time - c.time)) / d.stage.duration;
    const x = c.mode === 'rtl' ? d.stage.width - elapsed : elapsed - c.width;
    expect(Math.abs(c.x - x), `${c.text} at ${d.time}`).toBeLessThan(1);
    n++;
  }
  return n;
}

test('danmaku follows media time: pause freezes, 2x doubles, positions match the media clock', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await expect.poll(async () => (await inspect(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(3);
  // Something is drawn, from the comments in flight.
  let d = await inspect(page);
  expect(d.running.length).toBeGreaterThan(2);
  expect(checkPositions(d)).toBeGreaterThan(0);
  const painted = await page.evaluate(() => {
    const c = document.querySelector('[data-otter-danmaku] canvas') as HTMLCanvasElement;
    const copy = new OffscreenCanvas(c.width, c.height);
    const ctx = copy.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(c, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if ((px[i] as number) > 0) n++;
    return n;
  });
  expect(painted).toBeGreaterThan(500);

  // Pause: the stage stays exactly where media time stopped, however long the wall clock runs.
  await dispatch(page, 'pause', undefined);
  await expect.poll(async () => (await otter(page)).paused).toBe(true);
  await page.waitForTimeout(300);
  const paused = await inspect(page);
  expect(Math.abs(paused.time - paused.currentTime)).toBeLessThan(0.01);
  await page.waitForTimeout(1500);
  const later = await inspect(page);
  expect(later.running).toEqual(paused.running);
  expect(later.frames).toBe(paused.frames);

  // 2x: media time runs twice as fast, and the comments with it.
  await dispatch(page, 'set-playback-rate', { rate: 2 });
  await dispatch(page, 'play', undefined);
  const t0 = Date.now();
  const m0 = paused.currentTime;
  await page.waitForTimeout(1500);
  d = await inspect(page);
  const media = d.currentTime - m0;
  const wall = (Date.now() - t0) / 1000;
  expect(media / wall).toBeGreaterThan(1.6);
  expect(Math.abs(d.time - d.currentTime)).toBeLessThan(0.3);
  checkPositions(d);
  ciNotice(`danmaku timeline: paused 1.5 s -> no frame, same positions; 2x -> ${media.toFixed(2)} s media in ${wall.toFixed(2)} s`);
});

test('danmaku seek rebuilds the stage at the new time, both ways', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await expect.poll(async () => (await inspect(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(1);
  await dispatch(page, 'pause', undefined);
  for (const target of [20, 3]) {
    await dispatch(page, 'seek', { time: target });
    await expect.poll(async () => Math.abs((await inspect(page)).time - target), { timeout: 10_000 }).toBeLessThan(0.1);
    const d = await inspect(page);
    // In flight at the new time: nothing later than it, nothing past its duration, and the
    // comment of that very moment is there.
    expect(d.running.length).toBeGreaterThan(0);
    for (const c of d.running) {
      expect(c.time).toBeLessThanOrEqual(d.time + 1e-6);
      expect(d.time - c.time).toBeLessThanOrEqual(c.mode === 'top' || c.mode === 'bottom' ? 4 : d.stage.duration);
    }
    expect(d.running.map((c) => c.text)).toContain(`#${Math.round((target - 0.5) * 2)} ${(target - 0.5).toFixed(1)}s`);
    checkPositions(d);
  }
});

test('a hidden page draws no danmaku; back in front it goes on', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page);
  await expect.poll(async () => (await inspect(page)).frames, { timeout: 15_000 }).toBeGreaterThan(10);
  const setHidden = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await setHidden(true);
  await page.waitForTimeout(200);
  const before = await inspect(page);
  await page.waitForTimeout(1500);
  const hidden = await inspect(page);
  expect(hidden.frames).toBe(before.frames);
  // Playback went on meanwhile (media time is the timeline: the stage catches up, no backlog).
  expect(hidden.currentTime).toBeGreaterThan(before.currentTime + 1);
  await setHidden(false);
  await expect.poll(async () => (await inspect(page)).frames, { timeout: 5000 }).toBeGreaterThan(hidden.frames);
  const back = await inspect(page);
  checkPositions(back);
});

test('settings page: opacity and hidden types apply; with preferences they survive a reload', async ({ page }) => {
  test.setTimeout(60_000);
  await start(page, '&prefs=1');
  const menu = page.locator('otter-settings-menu');
  await menu.getByRole('button').click();
  await menu.getByRole('menuitem', { name: /^Danmaku,/ }).click();
  await menu.getByRole('group', { name: 'Opacity' }).getByRole('menuitemradio', { name: '50%' }).click();
  await menu.getByRole('group', { name: 'Hide' }).getByRole('menuitemcheckbox', { name: 'Top' }).click();
  await expect.poll(async () => (await otter(page)).danmaku).toMatchObject({ opacity: 0.5, hideTop: true });
  await expect(page.locator('[data-otter-danmaku]')).toHaveCSS('opacity', '0.5');
  await expect.poll(async () => (await inspect(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(6);
  expect((await inspect(page)).running.some((c) => c.mode === 'top')).toBe(false);
  await page.reload();
  await start(page, '&prefs=1');
  await expect.poll(async () => (await otter(page)).danmaku).toMatchObject({ opacity: 0.5, hideTop: true });
  await expect(page.locator('[data-otter-danmaku]')).toHaveCSS('opacity', '0.5');
});
