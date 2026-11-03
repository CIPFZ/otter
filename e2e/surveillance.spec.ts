// The surveillance preset on live streams (ADR-013 §7): HTTP-FLV and WS-FLV through the pipeline's
// FLV samples, live MPEG-TS through mediabunny, into the WebCodecs backend, tiles on one wall.
//
// Two kinds of case per transport (owner 2026-11-02, ADR-013 §7):
// - function, in the main step: the four tiles play on WebCodecs; a click focuses one tile, which
//   alone has sound; a 7th HTTP stream to one host is warned about (tooManyConnectionsPerHost).
// - measurement, @solo (one worker, its own preview server: ADR-008 §7, a benchmark has the runner
//   to itself): real time and lost frames (GPU walls), and TTFF (SPEC §19 surveillance row, owner
//   2026-10-30): one FLV tile's median within 300 ms of the MSE pipeline's, live TS within 1 s, all
//   16 tiles of the @bench within 3 s. In the main step these swung with the runner's load (CI
//   macOS, M6 RESEARCH §1).
//
// Browsers open at most 6 HTTP/1.1 connections per host, which endless HTTP-FLV streams keep: more
// tiles from one host take WS-FLV (or HTTP/2).

import { appendFileSync, mkdirSync } from 'node:fs';
import { loadavg } from 'node:os';
import type { Browser, Page } from '@playwright/test';
import { acceptEnvironmentStalls, audioStalls, recordAudioStalls } from './audio-stalls';
import { expect, test } from './fixtures';
import type { SurveillancePlayer } from '@otter-player/presets/surveillance';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

type Tile = { label: string; muted: boolean; currentTime: number; backend: string | null; format: string | null; live: boolean; error: unknown; ttff: number | null; dropped: number; total: number; errors: string[]; messages: string[]; errorAt: number[] };
type Log = { errors: string[][]; messages: string[][]; errorAt: number[][]; stepsAt: { at: number; reason: string }[][] };

async function wall(page: Page, streams: readonly string[]): Promise<void> {
  // Each tile's errors (audioUnderrun counted apart) and route steps, with when they came; the
  // Workers the page starts (decode pool, render).
  await page.addInitScript(() => {
    const log: Log = { errors: [], messages: [], errorAt: [], stepsAt: [] };
    (window as unknown as { tileLog: Log }).tileLog = log;
    // The tiles' errors and route steps from the moment the page sets window.preset: a warning
    // said while the wall starts (tooManyConnectionsPerHost) comes before the load event.
    let preset: unknown;
    Object.defineProperty(window, 'preset', {
      configurable: true,
      get: () => preset,
      set(p: SurveillancePlayer) {
        preset = p;
        p.tiles.forEach((t, i) => {
          const errors: string[] = (log.errors[i] = []);
          const messages: string[] = (log.messages[i] = []);
          const errorAt: number[] = (log.errorAt[i] = []);
          const stepsAt: { at: number; reason: string }[] = (log.stepsAt[i] = []);
          t.qoe.on('error', (e) => {
            const err = (e as { error: { details: string; message?: string } }).error;
            errors.push(err.details);
            messages.push(`${err.details}: ${err.message ?? ''}`);
            errorAt.push(performance.now());
          });
          t.store.select(
            (st) => st.route?.steps,
            (steps, prev) => {
              for (const x of (steps ?? []).slice(prev?.length ?? 0)) stepsAt.push({ at: performance.now(), reason: x.reason });
            },
          );
        });
      },
    });
    const w = window as unknown as { workersMade: number };
    w.workersMade = 0;
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        w.workersMade++;
      }
    };
  });
  await page.goto(`/presets.html?preset=surveillance&streams=${streams.map(encodeURIComponent).join(',')}`);
  test.skip(!(await page.evaluate(() => typeof VideoDecoder === 'function')), 'no WebCodecs here');
}

const tiles = (page: Page): Promise<Tile[]> =>
  page.evaluate(() =>
    (window.preset as SurveillancePlayer).tiles.map((t, i) => {
      const s = t.store.getState();
      const log = (window as unknown as { tileLog: Log }).tileLog;
      return { label: t.label, muted: s.muted, currentTime: s.currentTime, backend: s.backend, format: s.format, live: s.live, error: s.error, ttff: s.qoe.ttff, dropped: s.qoe.droppedFrames, total: s.qoe.totalFrames, errors: log.errors[i] ?? [], messages: log.messages[i] ?? [], errorAt: log.errorAt[i] ?? [] };
    }),
  );

const kind = (page: Page): Promise<string> => page.evaluate(() => (window.preset as SurveillancePlayer).wall.kind);

/**
 * Each tile's time to first frame in phases (the backend's `startup ms:` route step, owner
 * 2026-11-02): connect / first bytes / keyframe / decoder configured / decoded / shown, ms from load.
 */
const ttffPhases = (page: Page): Promise<string> =>
  page.evaluate(() =>
    (window.preset as SurveillancePlayer).tiles
      .map((t, i) => `${i + 1}: ${(t.explain()?.steps.find((s) => s.reason.startsWith('startup ms:'))?.reason ?? 'no breakdown').replace('startup ms: ', '')}`)
      .join(' | '),
  );

/** What the wall draws here: canvas pixels per tile, DPR, Workers made, cores (M6: 3.1x between desktop-safari and emulated-iphone, RESEARCH §1). */
const geometry = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const c = document.querySelector('[data-otter-multiview] canvas') as HTMLCanvasElement | null;
    const n = (window.preset as SurveillancePlayer).tiles.length;
    const px = c === null ? 0 : Math.round((c.width * c.height) / n);
    const tiles = (window.preset as SurveillancePlayer).tiles;
    // The decoder each tile runs on (`<codec> on <decoder> (<hardware|software>)`) and every route
    // step that depends on the platform (owner 2026-11-03: does a mobile UA pick a weaker path?).
    const decoders = [...new Set(tiles.map((t) => /^(\S+) on (\S+) \((\w+)\)/.exec(t.explain()?.steps.find((x) => / on \S+ \((hardware|software)\)/.test(x.reason))?.reason ?? '')?.slice(1).join(' ') ?? 'none'))];
    const platform = [...new Set(tiles.flatMap((t) => (t.explain()?.steps ?? []).filter((x) => /iPhone|mobile|touch|coarse|ManagedMediaSource|MMS|user ?agent/i.test(x.reason)).map((x) => `${x.candidate}: ${x.reason}`)))];
    return `canvas ${c?.width ?? 0}x${c?.height ?? 0} (${px} px per tile, css ${Math.round(c?.clientWidth ?? 0)}x${Math.round(c?.clientHeight ?? 0)}), dpr ${devicePixelRatio}, workers ${(window as unknown as { workersMade: number }).workersMade}, cores ${navigator.hardwareConcurrency}, decoders ${decoders.join(' / ')}, coarse pointer ${matchMedia('(pointer: coarse)').matches}, platform route steps ${platform.join(' | ') || 'none'}`;
  });

/** The machine during a play window: load average, WHEP sessions the fixture still sends to (M6). */
const machineLoad = async (page: Page): Promise<string> => {
  const whep = await page.request.get('/whep/sessions').then((r) => r.text(), () => '?');
  return `whep sessions ${whep}; load ${loadavg().map((x) => x.toFixed(1)).join(' ')}`;
};

/** `seconds` of play: per tile media time advanced and the share of frames lost. */
async function play(page: Page, seconds: number) {
  const before = await tiles(page);
  const load = machineLoad(page);
  await page.waitForTimeout(seconds * 1000);
  const after = await tiles(page);
  ciNotice(`surveillance machine (${test.info().title.slice(14, 30)}, attempt ${test.info().retry + 1}): ${await load}`);
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

type Transport = 'http' | 'ws' | 'ts';
const NAMES: Record<Transport, string> = { http: 'HTTP-FLV', ws: 'WS-FLV', ts: 'live MPEG-TS' };
const urlOf = (transport: Transport, baseURL: string): string =>
  transport === 'http' ? '/live/stream.flv' : transport === 'ws' ? `${baseURL.replace(/^http/, 'ws')}/live/stream.flv` : '/live/stream.ts';

/** Four tiles of `transport` on a wall, all playing on WebCodecs as live streams. */
async function fourPlaying(page: Page, transport: Transport, baseURL: string): Promise<void> {
  await wall(page, Array(4).fill(urlOf(transport, baseURL)));
  await expect.poll(async () => (await tiles(page)).map((t) => t.currentTime > 1), { timeout: 30_000 }).toEqual([true, true, true, true]);
  for (const t of await tiles(page)) expect(t).toMatchObject({ backend: 'webcodecs', format: transport === 'ts' ? 'ts' : 'flv', live: true, error: null });
}

for (const transport of ['http', 'ws', 'ts'] as const) {
  test(`surveillance: four ${NAMES[transport]} live streams play on WebCodecs${transport === 'http' ? '; a click focuses a tile, which alone has sound' : ''}`, async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    await fourPlaying(page, transport, baseURL as string);
    // Function only (the measurement is the @solo case): every tile's time moves.
    const rows = await play(page, 2);
    for (const r of rows) expect(r.advanced, `${r.tile} moves`).toBeGreaterThan(0.5);
    if (transport !== 'http') return;
    // A click focuses the top-right tile (a gesture): within 1 s only it is unmuted (F1: the others
    // stay muted; the first gesture lifts the gate).
    // Clear of the bars and the centre buttons, which small players put over the tiles (as in
    // multiview.spec; the emulated iPhone timed out on the tile's centre at d7163de).
    const tile = page.locator('[data-otter-multiview-tile="2"]');
    const box = (await tile.boundingBox()) as { width: number; height: number };
    await tile.click({ position: { x: box.width * 0.85, y: box.height * 0.6 } });
    await expect.poll(() => page.evaluate(() => (window.preset as SurveillancePlayer).focused)).toBe(1);
    await expect.poll(async () => (await tiles(page)).map((t) => t.muted), { timeout: 1000 }).toEqual([true, false, true, true]);
  });

  test(`surveillance: four ${NAMES[transport]} live streams, measured alone: each in real time, lost frames${transport === 'http' ? ', one tile\'s TTFF against the MSE pipeline' : ''}${transport === 'ts' ? ', TTFF within 1 s' : ''} @solo`, async ({ page, browser, baseURL }) => {
    test.setTimeout(90_000);
    // The shared AudioContext's own stall record (e2e/audio-stalls.ts): a tile that falls behind
    // real time may be its clock standing (owner 2026-11-03).
    await recordAudioStalls(page);
    await fourPlaying(page, transport, baseURL as string);
    const rows = await play(page, 5);
    const k = await kind(page);
    let ttffNote = '';
    const one: number[] = [];
    const ref: number[] = [];
    if (transport === 'http') {
      // TTFF like for like, one stream each: a one-tile wall against the MSE player, three of each.
      for (let n = 0; n < 3; n++) {
        ref.push(await mseTtff(browser));
        one.push(await oneTileTtff(browser, '/live/stream.flv'));
      }
      ttffNote = `one tile TTFF median ${Math.round(median(one))} ms (${one.map(Math.round).join(' / ')}) vs MSE pipeline ${Math.round(median(ref))} ms (${ref.map(Math.round).join(' / ')}); `;
      test.info().annotations.push({ type: 'ttff', description: `${one.join(' ')} | ${ref.join(' ')}` });
    }
    const name = transport === 'ts' ? 'live ts' : `${transport}-flv`;
    ciNotice(`surveillance ${name} x4 (${k} wall, solo, attempt ${test.info().retry + 1}): ${await geometry(page)}; AudioContext stalls ≥ 300 ms ${(await audioStalls(page)).join(', ') || 'none'}; tile errors ${rows.flatMap((r) => r.messages).join(' | ') || 'none'}; TTFF phases ${await ttffPhases(page)}; ${ttffNote}four tiles TTFF ${rows.map((r) => Math.round(r.ttff ?? -1)).join(' / ')} ms; 5 s played ${rows.map((r) => r.advanced.toFixed(2)).join(' / ')} s; lost ${rows.map((r) => `${(r.lost * 100).toFixed(1)} %`).join(' / ')}`);
    for (const r of rows) expect(r.advanced, `${r.tile}: real time`).toBeGreaterThan(4.5);
    // The lost-frame criterion is the GPU wall's (a 2D wall draws on the main thread: headless Firefox).
    if (k === 'gpu') for (const r of rows) expect(r.lost, `${r.tile}: lost frames`).toBeLessThanOrEqual(0.05);
    if (transport === 'http') expect(median(one), `one tile's TTFF median against the MSE pipeline's (${Math.round(median(ref))} ms) + 300 ms`).toBeLessThanOrEqual(median(ref) + 300);
    if (transport === 'ts') for (const r of rows) expect(r.ttff ?? Infinity, `${r.tile}: live TS TTFF ≤ 1 s`).toBeLessThanOrEqual(1000);
  });
}

test('surveillance: a 7th HTTP-FLV stream to one host is warned about (tooManyConnectionsPerHost, non-fatal); six of the seven play', async ({ page }) => {
  test.setTimeout(60_000);
  // Seven tiles need the GPU wall (a 2D wall takes 4): not on headless Firefox.
  const gl = await page.goto('/presets.html').then(() => page.evaluate(() => document.createElement('canvas').getContext('webgl2') !== null));
  test.skip(!gl, 'no WebGL2 here: a 2D wall takes at most 4 tiles');
  await wall(page, Array(7).fill('/live/stream.flv'));
  const log = () => page.evaluate(() => (window as unknown as { tileLog: Log }).tileLog.errors.map((e) => e.filter((x) => x === 'tooManyConnectionsPerHost').length));
  await expect.poll(log).toEqual([0, 0, 0, 0, 0, 0, 1]);
  // Six connections: six tiles play, one waits (which one is the browser's choice: the order the
  // requests went out in, not the list's).
  await expect.poll(async () => (await tiles(page)).filter((t) => t.currentTime > 1).length, { timeout: 30_000 }).toBe(6);
  await page.waitForTimeout(2000);
  expect((await tiles(page)).filter((t) => t.currentTime > 1)).toHaveLength(6);
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
