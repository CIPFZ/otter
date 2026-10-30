// The surveillance preset on FLV live streams (ADR-013 §7): HTTP-FLV and WS-FLV through the
// pipeline's FLV samples into the WebCodecs backend, tiles on one wall. TTFF against the MSE
// pipeline on the same stream (one each, the cn-live rule); real time and lost frames as the
// wall's acceptance (ADR-008 §7: GPU walls). Browsers open at most 6 HTTP/1.1 connections per host,
// which endless HTTP-FLV streams keep: more tiles from one host take WS-FLV (or HTTP/2).

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { SurveillancePlayer } from '@otter-player/presets/surveillance';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

type Tile = { currentTime: number; backend: string | null; format: string | null; live: boolean; error: unknown; ttff: number | null; dropped: number; total: number; errors: string[] };

async function wall(page: Page, streams: readonly string[]): Promise<void> {
  // Each tile's errors, kept (audioUnderrun counted apart).
  await page.addInitScript(() => {
    (window as unknown as { tileErrors: string[][] }).tileErrors = [];
  });
  await page.goto(`/presets.html?preset=surveillance&streams=${streams.map(encodeURIComponent).join(',')}`);
  test.skip(!(await page.evaluate(() => typeof VideoDecoder === 'function')), 'no WebCodecs here');
  await page.evaluate(() => {
    const w = window as unknown as { tileErrors: string[][] };
    (window.preset as SurveillancePlayer).tiles.forEach((t, i) => {
      w.tileErrors[i] = [];
      t.qoe.on('error', (p) => w.tileErrors[i]?.push((p as { error: { details: string } }).error.details));
    });
  });
}

const tiles = (page: Page): Promise<Tile[]> =>
  page.evaluate(() =>
    (window.preset as SurveillancePlayer).tiles.map((t, i) => {
      const s = t.store.getState();
      return { currentTime: s.currentTime, backend: s.backend, format: s.format, live: s.live, error: s.error, ttff: s.qoe.ttff, dropped: s.qoe.droppedFrames, total: s.qoe.totalFrames, errors: (window as unknown as { tileErrors: string[][] }).tileErrors[i] ?? [] };
    }),
  );

const kind = (page: Page): Promise<string> => page.evaluate(() => (window.preset as SurveillancePlayer).wall.kind);

/** `seconds` of play: per tile media time advanced and the share of frames lost. */
async function play(page: Page, seconds: number) {
  const before = await tiles(page);
  await page.waitForTimeout(seconds * 1000);
  const after = await tiles(page);
  return after.map((t, i) => {
    const b = before[i] as Tile;
    const total = t.total - b.total;
    return { advanced: t.currentTime - b.currentTime, lost: total > 0 ? (t.dropped - b.dropped) / total : 0, ttff: t.ttff, errors: t.errors };
  });
}

for (const transport of ['http', 'ws'] as const) {
  test(`surveillance: four ${transport === 'http' ? 'HTTP' : 'WS'}-FLV live streams on WebCodecs, each in real time${transport === 'http' ? '; one tile\'s TTFF against the MSE pipeline' : ''}`, async ({ page, browser, baseURL }) => {
    test.setTimeout(90_000);
    const url = transport === 'http' ? '/live/stream.flv' : `${(baseURL as string).replace(/^http/, 'ws')}/live/stream.flv`;
    await wall(page, Array(4).fill(url));
    await expect.poll(async () => (await tiles(page)).map((t) => t.currentTime > 1), { timeout: 30_000 }).toEqual([true, true, true, true]);
    for (const t of await tiles(page)) expect(t).toMatchObject({ backend: 'webcodecs', format: 'flv', live: true, error: null });
    const rows = await play(page, 5);
    const k = await kind(page);
    let ttffNote = '';
    if (transport === 'http') {
      // TTFF like for like (the cn-live rule, one stream each): a one-tile wall against the MSE player.
      const ref = await browser.newPage();
      await ref.goto('/player.html?idle=0');
      await ref.evaluate(async () => {
        const o = (await window.otter) as { dispatch(t: string, p: unknown): void; load(s: unknown, o?: unknown): void };
        o.dispatch('set-muted', { muted: true });
        o.load({ src: '/live/stream.flv', type: 'video/x-flv', live: true }, { autoplay: true });
      });
      await expect.poll(() => ref.evaluate(async () => ((await window.otter) as { state(): { qoe: { ttff: number | null } } }).state().qoe.ttff), { timeout: 20_000 }).not.toBeNull();
      const refTtff = (await ref.evaluate(async () => ((await window.otter) as { state(): { qoe: { ttff: number } } }).state().qoe.ttff)) as number;
      await ref.close();
      const one = await browser.newPage();
      await one.goto('/presets.html?preset=surveillance&streams=/live/stream.flv');
      await expect.poll(() => one.evaluate(() => (window.preset as SurveillancePlayer).tiles[0]?.store.getState().qoe.ttff ?? null), { timeout: 20_000 }).not.toBeNull();
      const oneTtff = (await one.evaluate(() => (window.preset as SurveillancePlayer).tiles[0]?.store.getState().qoe.ttff)) as number;
      await one.close();
      ttffNote = `one tile TTFF ${Math.round(oneTtff)} ms vs MSE pipeline ${Math.round(refTtff)} ms; `;
      test.info().annotations.push({ type: 'ttff', description: `${oneTtff} ${refTtff}` });
    }
    ciNotice(`surveillance ${transport}-flv x4 (${k} wall): ${ttffNote}four tiles TTFF ${rows.map((r) => Math.round(r.ttff ?? -1)).join(' / ')} ms; 5 s played ${rows.map((r) => r.advanced.toFixed(2)).join(' / ')} s; lost ${rows.map((r) => `${(r.lost * 100).toFixed(1)} %`).join(' / ')}`);
    for (const r of rows) expect(r.advanced).toBeGreaterThan(4.5);
    // The lost-frame criterion is the GPU wall's (a 2D wall draws on the main thread: headless Firefox).
    if (k === 'gpu') for (const r of rows) expect(r.lost).toBeLessThanOrEqual(0.05);
  });
}

test('surveillance: four live MPEG-TS streams on WebCodecs (mediabunny reading the stream as it arrives), each in real time', async ({ page }) => {
  test.setTimeout(90_000);
  await wall(page, Array(4).fill('/live/stream.ts'));
  await expect.poll(async () => (await tiles(page)).map((t) => t.currentTime > 1), { timeout: 30_000 }).toEqual([true, true, true, true]);
  for (const t of await tiles(page)) expect(t).toMatchObject({ backend: 'webcodecs', format: 'ts', live: true, error: null });
  const rows = await play(page, 5);
  const k = await kind(page);
  ciNotice(`surveillance live ts x4 (${k} wall): TTFF ${rows.map((r) => Math.round(r.ttff ?? -1)).join(' / ')} ms; 5 s played ${rows.map((r) => r.advanced.toFixed(2)).join(' / ')} s; lost ${rows.map((r) => `${(r.lost * 100).toFixed(1)} %`).join(' / ')}`);
  for (const r of rows) expect(r.advanced).toBeGreaterThan(4.5);
  if (k === 'gpu') for (const r of rows) expect(r.lost).toBeLessThanOrEqual(0.05);
});

// A benchmark (@bench): 16 WS-FLV tiles (16 HTTP-FLV from one host do not fit the browser's 6
// connections per host). desktop-chrome / real Edge, 8+ cores, one worker.
test('surveillance: 16 WS-FLV live streams on one wall over 10 s: real time, lost frames, audio underruns @bench', async ({ page, baseURL }, info) => {
  test.setTimeout(120_000);
  test.skip(!['desktop-chrome', 'real-windows-edge'].includes(info.project.name), 'desktop Chrome and the real Edge');
  const cores = await page.evaluate(() => navigator.hardwareConcurrency);
  test.skip(cores < 8, `${cores} cores`);
  await wall(page, Array(16).fill(`${(baseURL as string).replace(/^http/, 'ws')}/live/stream.flv`));
  await expect.poll(async () => (await tiles(page)).filter((t) => t.currentTime > 1).length, { timeout: 60_000 }).toBe(16);
  await page.waitForTimeout(2000);
  const rows = await play(page, 10);
  const k = await kind(page);
  const underruns = rows.reduce((n, r) => n + r.errors.filter((e) => e === 'audioUnderrun').length, 0);
  const other = rows.flatMap((r) => r.errors.filter((e) => e !== 'audioUnderrun'));
  ciNotice(
    `surveillance ws-flv x16 (${k} wall, ${cores} cores): 10 s played min ${Math.min(...rows.map((r) => r.advanced)).toFixed(2)} s; lost max ${(Math.max(...rows.map((r) => r.lost)) * 100).toFixed(1)} %; TTFF ${Math.round(Math.min(...rows.map((r) => r.ttff ?? 0)))}..${Math.round(Math.max(...rows.map((r) => r.ttff ?? 0)))} ms; audio underruns ${underruns}; other errors ${other.join(', ') || 'none'}`,
  );
  for (const r of rows) {
    expect(r.advanced).toBeGreaterThan(9);
    if (k === 'gpu') expect(r.lost).toBeLessThanOrEqual(0.05);
  }
  expect(other).toEqual([]);
});
