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
  await expect.poll(async () => (await otter(page)).danmakuStatus, { timeout: 15_000 }).toMatchObject({ status: 'ready', count: 60, skipped: 3 });
}

/**
 * Pixels the danmaku stage changes in a screenshot of the player (any renderer: a WebGL canvas
 * cannot be read back after compositing).
 */
async function stagePixels(page: Page): Promise<number> {
  const box = page.locator('video');
  const shot = async (): Promise<string> => (await box.screenshot({ animations: 'disabled' })).toString('base64');
  const shown = await shot();
  await page.evaluate(() => ((document.querySelector('[data-otter-danmaku]') as HTMLElement).style.visibility = 'hidden'));
  const hidden = await shot();
  await page.evaluate(() => ((document.querySelector('[data-otter-danmaku]') as HTMLElement).style.visibility = ''));
  return page.evaluate(async ([a, b]) => {
    const read = async (s: string): Promise<Uint8ClampedArray> => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.width, img.height).data;
    };
    const [x, y] = await Promise.all([read(a), read(b)]);
    let n = 0;
    for (let i = 0; i < x.length; i += 4) if (Math.abs((x[i] as number) - (y[i] as number)) + Math.abs((x[i + 1] as number) - (y[i + 1] as number)) + Math.abs((x[i + 2] as number) - (y[i + 2] as number)) > 60) n++;
    return n;
  }, [shown, hidden] as const);
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

for (const renderer of ['canvas2d', 'webgl', 'worker'] as const) {
test(`danmaku on ${renderer} follows media time: pause freezes, 2x doubles, positions match the media clock`, async ({ page }) => {
  test.setTimeout(60_000);
  await start(page, `&renderer=${renderer}`);
  await expect.poll(async () => (await inspect(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(3);
  // Something is drawn, from the comments in flight.
  let d = await inspect(page);
  expect(d.running.length).toBeGreaterThan(2);
  expect(checkPositions(d)).toBeGreaterThan(0);
  // The renderer asked for, or Canvas 2D with the reason it could not run (headless Firefox: no WebGL).
  const st = (await otter(page)).danmakuStatus;
  if (st.renderer !== renderer) {
    expect(renderer).not.toBe('canvas2d');
    expect(st.steps).toContainEqual(expect.objectContaining({ candidate: renderer, outcome: 'rejected' }));
    expect(st.renderer).toBe('canvas2d');
  }

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
  // Drawn: the stage changes the picture where comments are.
  const changed = await stagePixels(page);
  expect(changed).toBeGreaterThan(500);

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
  ciNotice(`danmaku timeline (${st.renderer}${st.renderer === renderer ? '' : `, ${renderer} rejected`}): paused 1.5 s -> no frame, same positions, ${changed} px drawn; 2x -> ${media.toFixed(2)} s media in ${wall.toFixed(2)} s`);
});
}

test('auto: Canvas 2D at first, WebGL when the stage gets dense, the Worker when the page is busy; each step explained', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await start(page);
  const steps = async () => (await otter(page)).danmakuStatus.steps;
  expect((await steps())[0]).toEqual({ candidate: 'canvas2d', outcome: 'selected', reason: 'default: Canvas 2D (auto)' });
  // Dense: 40 comments a second for the rest of the clip.
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const t0 = o.state().currentTime;
    o.dispatch('load-danmaku', { comments: Array.from({ length: 1000 }, (_, i) => ({ time: t0 + i / 40, text: `弹${i % 100}` })) });
  });
  await expect.poll(async () => (await steps()).map((x) => `${x.candidate} ${x.outcome}`), { timeout: 30_000 }).toContainEqual(expect.stringMatching(/^webgl (selected|rejected)$/));
  const dense = (await steps()).find((x) => x.candidate === 'webgl');
  if (dense?.outcome === 'selected') {
    expect(dense.reason).toMatch(/^dense: \d+ comments on stage \(≥ 120\)$/);
    // A busy page: 30 ms of someone else's work every 30 ms.
    await page.evaluate(() => {
      setInterval(() => {
        const end = performance.now() + 30;
        while (performance.now() < end);
      }, 30);
    });
    await expect.poll(async () => (await steps()).map((x) => `${x.candidate} ${x.outcome}`), { timeout: 40_000 }).toContainEqual(expect.stringMatching(/^worker (selected|rejected)$/));
    const busy = (await steps()).find((x) => x.candidate === 'worker');
    if (busy?.outcome === 'selected') expect(busy.reason).toMatch(/^main thread busy: frame interval p90 [\d.]+ ms \(≥ 25\)/);
  } else {
    expect(dense?.reason).toBe('no WebGL2 context');
  }
  const st = (await otter(page)).danmakuStatus;
  expect(st.renderer).toBe(st.steps.filter((x) => x.outcome === 'selected').at(-1)?.candidate);
  ciNotice(`danmaku auto renderer: ${st.steps.map((x) => `${x.candidate} ${x.outcome}: ${x.reason}`).join(' | ')}`);
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
