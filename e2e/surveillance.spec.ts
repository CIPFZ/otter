// The surveillance preset on FLV live streams (ADR-013 §7): HTTP-FLV and WS-FLV through the
// pipeline's FLV samples into the WebCodecs backend, tiles on one wall. TTFF against the MSE
// pipeline on the same stream; real time and lost frames as the wall's acceptance (ADR-008 §7: GPU
// walls). TTFF (SPEC §19 surveillance row, owner 2026-10-30): one FLV tile's median within 300 ms of
// the MSE pipeline's, live TS within 1 s, all 16 tiles of the bench within 3 s. Browsers open at most 6 HTTP/1.1 connections per host,
// which endless HTTP-FLV streams keep: more tiles from one host take WS-FLV (or HTTP/2).

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import { acceptEnvironmentStalls, audioStalls, recordAudioStalls } from './audio-stalls';
import { expect, test } from './fixtures';
import type { SurveillancePlayer } from '@otter-player/presets/surveillance';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

type Tile = { label: string; currentTime: number; backend: string | null; format: string | null; live: boolean; error: unknown; ttff: number | null; dropped: number; total: number; errors: string[]; messages: string[]; errorAt: number[] };
type Log = { errors: string[][]; messages: string[][]; errorAt: number[][]; stepsAt: { at: number; reason: string }[][] };

async function wall(page: Page, streams: readonly string[]): Promise<void> {
  // Each tile's errors (audioUnderrun counted apart) and route steps, with when they came.
  await page.addInitScript(() => {
    (window as unknown as { tileLog: Log }).tileLog = { errors: [], messages: [], errorAt: [], stepsAt: [] };
  });
  await page.goto(`/presets.html?preset=surveillance&streams=${streams.map(encodeURIComponent).join(',')}`);
  test.skip(!(await page.evaluate(() => typeof VideoDecoder === 'function')), 'no WebCodecs here');
  await page.evaluate(() => {
    const log = (window as unknown as { tileLog: Log }).tileLog;
    (window.preset as SurveillancePlayer).tiles.forEach((t, i) => {
      const errors: string[] = (log.errors[i] = []);
      const messages: string[] = (log.messages[i] = []);
      const errorAt: number[] = (log.errorAt[i] = []);
      const stepsAt: { at: number; reason: string }[] = (log.stepsAt[i] = []);
      t.qoe.on('error', (p) => {
        const e = (p as { error: { details: string; message?: string } }).error;
        errors.push(e.details);
        messages.push(`${e.details}: ${e.message ?? ''}`);
        errorAt.push(performance.now());
      });
      t.store.select(
        (s) => s.route?.steps,
        (steps, prev) => {
          for (const st of (steps ?? []).slice(prev?.length ?? 0)) stepsAt.push({ at: performance.now(), reason: st.reason });
        },
      );
    });
  });
}

const tiles = (page: Page): Promise<Tile[]> =>
  page.evaluate(() =>
    (window.preset as SurveillancePlayer).tiles.map((t, i) => {
      const s = t.store.getState();
      const log = (window as unknown as { tileLog: Log }).tileLog;
      return { label: t.label, currentTime: s.currentTime, backend: s.backend, format: s.format, live: s.live, error: s.error, ttff: s.qoe.ttff, dropped: s.qoe.droppedFrames, total: s.qoe.totalFrames, errors: log.errors[i] ?? [], messages: log.messages[i] ?? [], errorAt: log.errorAt[i] ?? [] };
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
    return { tile: t.label, advanced: t.currentTime - b.currentTime, lost: total > 0 ? (t.dropped - b.dropped) / total : 0, ttff: t.ttff, errors: t.errors, messages: t.messages, errorAt: t.errorAt };
  });
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** TTFF of the MSE player (own FLV pipeline) on the live stream, in a page of its own. */
async function mseTtff(browser: Browser): Promise<number> {
  const ref = await browser.newPage();
  await ref.goto('/player.html?idle=0');
  await ref.evaluate(async () => {
    const o = (await window.otter) as { dispatch(t: string, p: unknown): void; load(s: unknown, o?: unknown): void };
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/live/stream.flv', type: 'video/x-flv', live: true }, { autoplay: true });
  });
  await expect.poll(() => ref.evaluate(async () => ((await window.otter) as { state(): { qoe: { ttff: number | null } } }).state().qoe.ttff), { timeout: 20_000 }).not.toBeNull();
  const ttff = (await ref.evaluate(async () => ((await window.otter) as { state(): { qoe: { ttff: number } } }).state().qoe.ttff)) as number;
  await ref.close();
  return ttff;
}

/** TTFF of a one-tile surveillance wall, in a page of its own. */
async function oneTileTtff(browser: Browser, url: string): Promise<number> {
  const one = await browser.newPage();
  await one.goto(`/presets.html?preset=surveillance&streams=${encodeURIComponent(url)}`);
  await expect.poll(() => one.evaluate(() => (window.preset as SurveillancePlayer).tiles[0]?.store.getState().qoe.ttff ?? null), { timeout: 20_000 }).not.toBeNull();
  const ttff = (await one.evaluate(() => (window.preset as SurveillancePlayer).tiles[0]?.store.getState().qoe.ttff)) as number;
  await one.close();
  return ttff;
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
    let one: number[] = [];
    let ref: number[] = [];
    if (transport === 'http') {
      // TTFF like for like, one stream each: a one-tile wall against the MSE player, three of each.
      for (let n = 0; n < 3; n++) {
        ref.push(await mseTtff(browser));
        one.push(await oneTileTtff(browser, '/live/stream.flv'));
      }
      ttffNote = `one tile TTFF median ${Math.round(median(one))} ms (${one.map(Math.round).join(' / ')}) vs MSE pipeline ${Math.round(median(ref))} ms (${ref.map(Math.round).join(' / ')}); `;
      test.info().annotations.push({ type: 'ttff', description: `${one.join(' ')} | ${ref.join(' ')}` });
    }
    ciNotice(`surveillance ${transport}-flv x4 (${k} wall): ${ttffNote}four tiles TTFF ${rows.map((r) => Math.round(r.ttff ?? -1)).join(' / ')} ms; 5 s played ${rows.map((r) => r.advanced.toFixed(2)).join(' / ')} s; lost ${rows.map((r) => `${(r.lost * 100).toFixed(1)} %`).join(' / ')}`);
    for (const r of rows) expect(r.advanced).toBeGreaterThan(4.5);
    // The lost-frame criterion is the GPU wall's (a 2D wall draws on the main thread: headless Firefox).
    if (k === 'gpu') for (const r of rows) expect(r.lost).toBeLessThanOrEqual(0.05);
    if (transport === 'http') expect(median(one), `one tile's TTFF median against the MSE pipeline's (${Math.round(median(ref))} ms) + 300 ms`).toBeLessThanOrEqual(median(ref) + 300);
  });
}

test('surveillance: four live MPEG-TS streams on WebCodecs (mediabunny reading the stream as it arrives), each in real time', async ({ page, browserName }) => {
  test.setTimeout(90_000);
  // Known flaky on CI WebKit (owner 2026-10-30, RESEARCH §1): the first attempt lost 5.3 % / played
  // 4.49 s of 5 on 2a8ac9a, the retry passed. Two more red runs in the next five CI runs make it a defect.
  const flaky = browserName === 'webkit';
  if (flaky) test.info().annotations.push({ type: 'flaky', description: 'CI WebKit live TS x4: lost 5.3 % (safari) / played 4.49 s (iphone) on the first attempt at 2a8ac9a; RESEARCH §1' });
  await wall(page, Array(4).fill('/live/stream.ts'));
  await expect.poll(async () => (await tiles(page)).map((t) => t.currentTime > 1), { timeout: 30_000 }).toEqual([true, true, true, true]);
  for (const t of await tiles(page)) expect(t).toMatchObject({ backend: 'webcodecs', format: 'ts', live: true, error: null });
  const rows = await play(page, 5);
  const k = await kind(page);
  ciNotice(`surveillance live ts x4 (${k} wall${flaky ? `, known flaky, attempt ${test.info().retry + 1}` : ''}): TTFF ${rows.map((r) => Math.round(r.ttff ?? -1)).join(' / ')} ms; 5 s played ${rows.map((r) => r.advanced.toFixed(2)).join(' / ')} s; lost ${rows.map((r) => `${(r.lost * 100).toFixed(1)} %`).join(' / ')}`);
  for (const r of rows) expect(r.advanced).toBeGreaterThan(4.5);
  if (k === 'gpu') for (const r of rows) expect(r.lost).toBeLessThanOrEqual(0.05);
  for (const r of rows) expect(r.ttff ?? Infinity, `${r.tile}: live TS TTFF ≤ 1 s`).toBeLessThanOrEqual(1000);
});

// A benchmark (@bench): 16 WS-FLV tiles (16 HTTP-FLV from one host do not fit the browser's 6
// connections per host). desktop-chrome / real Edge, 8+ cores, one worker.
test('surveillance: 16 WS-FLV live streams on one wall over 10 s: real time, lost frames, audio underruns @bench', async ({ page, baseURL }, info) => {
  test.setTimeout(120_000);
  test.skip(!['desktop-chrome', 'real-windows-edge'].includes(info.project.name), 'desktop Chrome and the real Edge');
  const cores = await page.evaluate(() => navigator.hardwareConcurrency);
  test.skip(cores < 8, `${cores} cores`);
  // The shared AudioContext's own stall record (e2e/audio-stalls.ts), as on the multi-view bench.
  await recordAudioStalls(page);
  await wall(page, Array(16).fill(`${(baseURL as string).replace(/^http/, 'ws')}/live/stream.flv`));
  await expect.poll(async () => (await tiles(page)).filter((t) => t.currentTime > 1).length, { timeout: 60_000 }).toBe(16);
  await page.waitForTimeout(2000);
  const rows = await play(page, 10);
  const k = await kind(page);
  const underruns = rows.reduce((n, r) => n + r.errors.filter((e) => e === 'audioUnderrun').length, 0);
  // A frozen-clock report counts only when it is not a proven environment stall (owner 2026-10-29).
  const { kept, accepted } = await acceptEnvironmentStalls(page, rows, (i) =>
    page.evaluate((i) => (window as unknown as { tileLog: Log }).tileLog.stepsAt[i]?.find((y) => /^audio clock: back on the AudioContext/.test(y.reason)) ?? null, i),
  );
  const other = kept.flatMap((e) => e.filter((x) => x !== 'audioUnderrun'));
  const stalls = await audioStalls(page);
  if (accepted.length > 0) ciNotice(`surveillance: 环境停顿 (environment stall, accepted): ${accepted.join(' | ')}`);
  ciNotice(
    `surveillance ws-flv x16 (${k} wall, ${cores} cores): 10 s played min ${Math.min(...rows.map((r) => r.advanced)).toFixed(2)} s; lost max ${(Math.max(...rows.map((r) => r.lost)) * 100).toFixed(1)} %; TTFF ${Math.round(Math.min(...rows.map((r) => r.ttff ?? 0)))}..${Math.round(Math.max(...rows.map((r) => r.ttff ?? 0)))} ms; audio underruns ${underruns}; environment stalls accepted ${accepted.length}; other errors ${other.join(', ') || 'none'}; AudioContext stalls ≥ 300 ms: ${stalls.join(', ') || 'none'}`,
  );
  for (const r of rows) {
    expect(r.advanced).toBeGreaterThan(9);
    if (k === 'gpu') expect(r.lost).toBeLessThanOrEqual(0.05);
    expect(r.ttff ?? Infinity, `${r.tile}: TTFF on a 16-tile wall ≤ 3 s`).toBeLessThanOrEqual(3000);
  }
  expect(other, rows.flatMap((r) => r.messages).join(' | ')).toEqual([]);
});
