// Multi-view wall in the player shell (ADR-008 §7, M4 acceptance): 16 streams of 720p HEVC on
// one shared canvas (one WebGL2 context, rendered in a Worker where possible), decoded in the
// shared Worker pool. Pictures are checked per tile from the frame number painted into the clip
// (generate-frames.sh: 96 px blocks across the top of a 1280x720 picture).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { WallFixture } from './site/player.ts';

const FPS = 30;
const covering = (t: number): number => Math.floor(t * FPS + 0.0005 * FPS + 1e-6);

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const wall = (page: Page) => ({
  eval: <T>(fn: (w: WallFixture) => T | Promise<T>): Promise<T> => page.evaluate(async (src) => {
    const w = await (window.wall as Promise<WallFixture>);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return (new Function('w', `return (${src})(w)`) as (w: WallFixture) => T)(w);
  }, fn.toString()),
});

/** Frame number in each of the wall's `cols` x `rows` tiles (or the whole wall: cols = rows = 1). */
async function framesOnWall(page: Page, cols: number, rows: number): Promise<number[]> {
  // The bars' gradients would darken the blocks, and a paused focused tile keeps them shown (as it
  // should): hide them for the screenshot only.
  const style = await page.addStyleTag({ content: '[data-otter-top], [data-otter-controls], [data-otter-center] { visibility: hidden !important; }' });
  const png = (await page.locator('[data-otter-multiview]').screenshot({ animations: 'disabled' })).toString('base64');
  await style.evaluate((el) => (el as Element).remove());
  return page.evaluate(
    async ([b64, c, r]) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      const tw = img.width / c;
      const th = img.height / r;
      const out: number[] = [];
      for (let row = 0; row < r; row++) {
        for (let col = 0; col < c; col++) {
          let bits = 0;
          for (let i = 0; i < 10; i++) {
            const d = ctx.getImageData(Math.floor(col * tw + ((i * 96 + 48) / 1280) * tw), Math.floor(row * th + (48 / 720) * th), 1, 1).data;
            if ((d[0] as number) + (d[1] as number) + (d[2] as number) > 384) bits |= 1 << i;
          }
          out.push(bits);
        }
      }
      return out;
    },
    [png, cols, rows] as const,
  );
}

/** Opens a wall of `count` streams and waits until the first 16 play (more wait for a decoder). */
async function open(page: Page, count: number, src?: string): Promise<void> {
  await page.goto(`/player.html?multiview=${count}&idle=0${src === undefined ? '' : `&src=${encodeURIComponent(src)}`}`);
  await expect
    .poll(() => page.evaluate(async () => (await (window.wall as Promise<WallFixture>)).tiles().filter((t) => t.status === 'ready').length), { timeout: 60_000 })
    .toBe(Math.min(16, count));
}

// A benchmark (@bench): 16 software-decoded 720p streams need the machine to themselves. Run alone,
// one worker: pnpm e2e --project=desktop-chrome --grep @bench --workers=1 (CI: its own step).
test('16 x 720p HEVC on one canvas: every tile plays its stream, the main thread keeps its frames @bench', async ({ page }, info) => {
  test.setTimeout(180_000);
  test.skip(!['desktop-chrome', 'real-windows-edge'].includes(info.project.name), 'the M4 acceptance runs in desktop Chrome (and on the real Windows Edge)');
  const cores = await page.evaluate(() => navigator.hardwareConcurrency);
  if (cores < 8) {
    ciNotice(`multiview bench skipped: ${cores} cores here, 16 software-decoded 720p HEVC streams need about 3 cores of decoding plus rendering (run it on an 8+ core machine)`);
    test.skip(true, `${cores} cores`);
  }
  // OTTER_BENCH_SRC=/frames/h264-720p.mp4: the same 720p clip in H.264, for machines without
  // hardware HEVC in WebCodecs (hardware decoding on the GPU instead of the WASM pool).
  const src = process.env['OTTER_BENCH_SRC'];
  // The shared AudioContext's time, recorded on its own every 20 ms (M6 F9): every stretch of
  // 300 ms or more in which it said running but its time did not move. `ctxStalls`: as `at+length`
  // ms after its creation; `ctxSpans`: performance.now() from / to (an open one: to = Infinity).
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    const w = window as unknown as { ctxStalls: string[]; ctxSpans: { from: number; to: number }[] };
    w.ctxStalls = [];
    w.ctxSpans = [];
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        const t0 = performance.now();
        let last = -1;
        let since = 0;
        let open: { from: number; to: number } | undefined;
        const id = setInterval(() => {
          const now = performance.now();
          if (this.state !== 'running' || this.currentTime !== last) {
            if (last >= 0 && now - since >= 300) w.ctxStalls.push(`${Math.round(since - t0)}+${Math.round(now - since)}${this.state === 'running' ? '' : ` (${this.state})`}`);
            if (open !== undefined) open.to = now;
            open = undefined;
            last = this.currentTime;
            since = now;
          } else if (open === undefined && now - since >= 300) {
            open = { from: since, to: Infinity };
            w.ctxSpans.push(open);
          }
          if (now - t0 > 60_000) clearInterval(id);
        }, 20);
      }
    };
  });
  await open(page, 16, src);
  // The hardware probes run on the fixture page: WebCodecs exists only in a secure context, and
  // about:blank (before open) is not one, which made both read false until 2026-10-29.
  // Hardware HEVC in WebCodecs here? (With it the tiles decode on the GPU, not in the WASM pool.)
  const hevcHardware = await page.evaluate(async () =>
    typeof VideoDecoder === 'function'
      ? (await VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L93.B0', codedWidth: 1280, codedHeight: 720, hardwareAcceleration: 'prefer-hardware' })).supported === true
      : false,
  );
  // Hardware H.264 in WebCodecs for the OTTER_BENCH_SRC clip (h264-720p.mp4 is Main@3.1), for the
  // hardware-path tolerance.
  const h264Hardware = await page.evaluate(async () =>
    typeof VideoDecoder === 'function'
      ? (await VideoDecoder.isConfigSupported({ codec: 'avc1.4d401f', codedWidth: 1280, codedHeight: 720, hardwareAcceleration: 'prefer-hardware' })).supported === true
      : false,
  );
  const w = wall(page);
  const kind = await w.eval((x) => x.kind);
  // Before any input the WebCodecs backend makes no AudioContext (M6 test round F1).
  const activated = await page.evaluate(() => (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? 'unknown');
  // Whole-browser CPU (all processes: browser, renderer, GPU, utility), from Chromium's
  // SystemInfo.getProcessInfo: the per-stream cost with hardware decoding, where the pool's
  // busy time does not apply.
  const cdp = await page.context().browser()?.newBrowserCDPSession();
  const processCpu = async (): Promise<Record<string, number>> => {
    const r = (await cdp?.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; cpuTime: number }[] } | undefined;
    const out: Record<string, number> = {};
    for (const p of r?.processInfo ?? []) out[p.type] = (out[p.type] ?? 0) + p.cpuTime;
    return out;
  };
  // Warm up, then 10 s of measurement (the 10 s clip loops).
  await page.waitForTimeout(2000);
  const cpu0 = await processCpu();
  const before = await w.eval((x) => ({ tiles: x.tiles(), pool: x.pool(), at: performance.now() }));
  const main = await w.eval((x) => x.measure(10_000));
  const after = await w.eval((x) => ({ tiles: x.tiles(), pool: x.pool(), at: performance.now() }));
  const cpu1 = await processCpu();
  const wallMs = after.at - before.at;
  // Percent of one core per process type, and the whole browser divided by the 16 streams.
  const browserCpu = Object.fromEntries(Object.keys(cpu1).map((k) => [k, Math.round((((cpu1[k] ?? 0) - (cpu0[k] ?? 0)) / (wallMs / 1000)) * 1000) / 10]));
  const perStreamCpu = Math.round((Object.values(browserCpu).reduce((a, b) => a + b, 0) / 16) * 10) / 10;

  const rows = after.tiles.map((t, i) => {
    const b = before.tiles[i] as (typeof before.tiles)[number];
    // Pool slots only for WASM tiles (WebCodecs decodes outside the pool).
    const slot = t.backend === 'wasm' && after.pool.slots.find((s) => s.label.includes('wasm') || s.label.startsWith('hvc')) ? after.pool.slots[i] : undefined;
    const bSlot = slot === undefined ? undefined : before.pool.slots[i];
    const advanced = t.currentTime - b.currentTime + 10 * (t.loops - b.loops);
    const decoded = (slot?.frames ?? 0) - (bSlot?.frames ?? 0);
    const cpu = ((slot?.busyMs ?? 0) - (bSlot?.busyMs ?? 0)) / wallMs;
    return {
      tile: t.label,
      backend: t.backend,
      worker: slot?.worker,
      advancedS: Math.round(advanced * 100) / 100,
      // Decoder-pool figures: WASM tiles only (null for WebCodecs, which decodes outside the pool).
      decodedFrames: slot === undefined ? null : decoded,
      cpuPercentOfOneCore: slot === undefined ? null : Math.round(cpu * 1000) / 10,
      droppedByClock: t.dropped - b.dropped,
      replacedOnCanvas: t.replaced - b.replaced,
      errors: t.errors.filter((e) => e !== 'codecUnsupported'),
      messages: t.messages.filter((e) => !e.startsWith('codecUnsupported')),
      errorAt: t.errorAt.filter((_, k) => t.errors[k] !== 'codecUnsupported'),
      index: i,
    };
  });
  const stalls = await page.evaluate(() => (window as unknown as { ctxStalls: string[] }).ctxStalls);
  const report = { project: info.project.name, src: src ?? '/frames/hevc-720p.mp4', cores, kind, hevcHardware, browserCpu, perStreamCpu, mainThread: main, wallMs: Math.round(wallMs), workers: after.pool.workers, streams: rows };
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/multiview-${info.project.name}${src === undefined ? '' : '-' + (src.split('/').pop() ?? '')}.json`, JSON.stringify(report, null, 2));
  info.attach('multiview.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  const worst = rows.reduce((m, r) => ({ cpu: Math.max(m.cpu, r.cpuPercentOfOneCore ?? 0), lost: Math.max(m.lost, r.droppedByClock + r.replacedOnCanvas), slow: Math.min(m.slow, r.advancedS) }), { cpu: 0, lost: 0, slow: Infinity });
  ciNotice(`multiview 16 x 720p ${src === undefined ? 'HEVC' : src} (${rows[0]?.backend}, ${after.pool.workers} workers, ${kind}): main thread ${main.frames} rAF in 10 s, ${main.over20} > 20 ms, ${main.over34} > 34 ms, longest ${Math.round(main.longest)} ms, ${main.longTasks} long tasks; per stream worst CPU ${worst.cpu}% of a core (decoder pool), whole browser ${perStreamCpu}% of a core per stream (${JSON.stringify(browserCpu)}), hardware HEVC ${hevcHardware}, worst lost frames ${worst.lost}, slowest ${worst.slow} s played; hardware H.264 ${h264Hardware}; AudioContext stalls ≥ 300 ms: ${stalls.join(', ') || 'none'}`);

  // A frozen-clock report is accepted only as an environment stall (owner 2026-10-29): the
  // independent record shows the context's time standing >= 0.5 s around the report (the watchdog
  // fires 0.5 s into a stall), and the clock is back on the context within 5 s of the stall's end.
  const spans = await page.evaluate(() => (window as unknown as { ctxSpans: { from: number; to: number | null }[] }).ctxSpans.map((x) => ({ from: x.from, to: Number.isFinite(x.to) ? x.to : null })));
  const environment: string[] = [];
  for (const r of rows) {
    const kept: string[] = [];
    for (const [k, e] of r.errors.entries()) {
      const at = r.errorAt[k] as number;
      const span = spans.find((x) => (x.to ?? Infinity) - x.from >= 500 && at >= x.from + 450 && at <= (x.to ?? Infinity) + 100);
      if (e !== 'audioClockUnavailable' || !/time frozen/.test(r.messages[k] ?? '') || span === undefined) {
        kept.push(e);
        continue;
      }
      // The stall ends (if it has not), then within 5 s the route says the clock is back.
      await expect.poll(() => page.evaluate(() => (window as unknown as { ctxSpans: { to: number }[] }).ctxSpans.every((x) => Number.isFinite(x.to))), { timeout: 15_000 }).toBe(true);
      const end = await page.evaluate((from) => (window as unknown as { ctxSpans: { from: number; to: number }[] }).ctxSpans.find((x) => x.from === from)?.to ?? 0, span.from);
      const recovered = () =>
        page.evaluate(async (i) => {
          const x = await (window.wall as Promise<WallFixture>);
          return x.tiles()[i]?.route?.steps.find((st) => /^audio clock: back on the AudioContext after a [\d.]+ s stall$/.test(st.reason))?.reason ?? null;
        }, r.index);
      const wait = Math.max(500, end + 5000 - (await page.evaluate(() => performance.now())));
      await expect.poll(recovered, { timeout: wait, message: `${r.tile}: back on the AudioContext within 5 s of the stall's end` }).not.toBeNull();
      environment.push(`${r.tile}: environment stall ${Math.round(span.from)}..${Math.round(end)} ms (${((end - span.from) / 1000).toFixed(2)} s), reported at ${Math.round(at)} ms; ${await recovered()}`);
    }
    r.errors = kept;
  }
  if (environment.length > 0) ciNotice(`multiview: 环境停顿 (environment stall, accepted): ${environment.join(' | ')}`);
  // Main-thread attribution of every frame over 34 ms (M6, HEVC software path: GC / compositor ->
  // the hardware tolerance; our code -> fix): long animation frames and long tasks in it, and
  // whether it fell into an audio stall or next to a clock switch (an error report).
  if (main.slow.length > 0) {
    const errorTimes = rows.flatMap((r) => r.errorAt);
    const lines = main.slow.map((f) => {
      const stall = spans.find((x) => f.at >= x.from && f.at - f.ms <= (x.to ?? Infinity) + 500);
      const switchNear = errorTimes.some((t) => Math.abs(t - f.at) < 300);
      const loaf = f.loaf.map((l) => `LoAF ${Math.round(l.duration)} ms (blocking ${Math.round(l.blocking)}, render ${Math.round(l.render)}${l.scripts.length > 0 ? `; ${l.scripts.join(', ')}` : '; no script'})`).join(' + ') || 'no LoAF';
      return `${Math.round(f.ms)} ms frame at ${Math.round(f.at)}: ${loaf}; long tasks ${f.longTasks.map(Math.round).join('/') || 'none'}; ${stall === undefined ? 'no audio stall' : `in an audio stall ${Math.round(stall.from)}..${stall.to === null ? 'open' : Math.round(stall.to)}`}${switchNear ? ', next to a clock switch' : ''}`;
    });
    ciNotice(`multiview slow frames (${src ?? 'HEVC'}): ${lines.join(' | ')}`);
  }

  for (const r of rows) {
    expect(r.errors, `${r.tile}: ${r.messages.join(' | ')}; user activation ${activated}; context stalls ${stalls.join(', ') || 'none'}`).toEqual([]);
    // Real time: each stream played (nearly) all 10 s.
    expect(r.advancedS, r.tile).toBeGreaterThan(9);
    // Frames lost (skipped by the clock or never drawn): at most 5% of 300.
    expect(r.droppedByClock + r.replacedOnCanvas, r.tile).toBeLessThanOrEqual(15);
  }
  // The main thread keeps its frame rate: no long task, and at most one frame missed by two vsyncs
  // per 10 s window, hardware or software decoding (M6 F10, and 2026-10-29 for the software path:
  // in 20 runs on the real Edge every such frame had no script and no long task and fell on the
  // virtual sound device's stall, i.e. compositor / system; ADR-008 §7). The notices above have
  // the count and the attribution.
  expect(main.longTasks).toBe(0);
  const hardwarePath = rows.every((r) => r.backend === 'webcodecs') && (src?.includes('h264') === true ? h264Hardware : hevcHardware);
  expect(main.over34, `${main.over34} frames > 34 ms in 10 s (${hardwarePath ? 'hardware' : 'software'} decoding, ≤ 1)`).toBeLessThanOrEqual(1);
  expect(main.over20 / main.frames).toBeLessThan(0.02);

  // Every viewport shows its own stream: paused, each tile's picture is the frame of its clock.
  await page.evaluate(async () => {
    const x = await (window.wall as Promise<WallFixture>);
    const tiles = x.tiles();
    for (let i = 0; i < tiles.length; i++) x.dispatchTo(i, 'pause');
  });
  const times = await w.eval((x) => x.tiles().map((t) => t.currentTime));
  await expect.poll(() => framesOnWall(page, 4, 4), { timeout: 10_000 }).toEqual(times.map(covering));
});

test('focus: one tile has sound and the controls; double-click: local fullscreen and back', async ({ page }) => {
  test.setTimeout(120_000);
  // Playwright over WebDriver BiDi (stock Firefox) sends a double-click as two clicks of detail
  // 1 and no dblclick event (RESEARCH §1).
  test.skip(test.info().project.name === 'real-windows-firefox', 'no dblclick through WebDriver BiDi');
  await open(page, 4);
  const w = wall(page);
  expect(await w.eval((x) => x.focused())).toBe(0);
  // Before any user gesture all four are muted (F1: WebKit under Playwright has no activation);
  // where the page already has one (Chromium: page.evaluate gives it), the focused tile has sound.
  // What counts is whether the page has had a gesture by now (no API: taken as active): before one
  // all are muted; once there was one (also an activation Playwright itself gives WebKit pages
  // after load, seen on CI), the gate is lifted and the focused tile has the sound it was given.
  const atLoad = await w.eval((x) => x.activatedAtLoad);
  const activation = () => page.evaluate(() => (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true);
  await expect
    .poll(async () => {
      const muted = await w.eval((x) => x.tiles().map((t) => t.muted));
      const want = (await activation()) ? [false, true, true, true] : [true, true, true, true];
      return JSON.stringify(muted) === JSON.stringify(want) ? 'ok' : `muted ${JSON.stringify(muted)}, activation at load ${atLoad}, now ${await activation()}`;
    }, { timeout: 1000 })
    .toBe('ok');
  // Tile 2 is top right; click clear of the bars and the centre buttons (small players put them
  // over the tiles).
  const tile = page.locator('[data-otter-multiview-tile="2"]');
  const box = (await tile.boundingBox()) as { width: number; height: number };
  const at = { position: { x: box.width * 0.85, y: box.height * 0.6 } };
  // A click focuses it (and is a gesture): within 1 s only it is audible, the shell's controls
  // show its state.
  await tile.click(at);
  expect(await w.eval((x) => x.focused())).toBe(1);
  await expect.poll(() => w.eval((x) => x.tiles().map((t) => t.muted)), { timeout: 1000 }).toEqual([true, false, true, true]);
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  // The shell's play button acts on the focused tile only.
  await page.locator('otter-play-button:visible').first().click();
  await expect.poll(() => w.eval((x) => x.tiles().map((t) => t.paused))).toEqual([false, true, false, false]);
  expect(await w.eval((x) => x.shellState().paused)).toBe(true);
  // Double-click: it fills the wall (its picture at full size), the others are hidden.
  await tile.dblclick(at);
  expect(await w.eval((x) => x.expanded())).toBe(1);
  const t2 = await w.eval((x) => (x.tiles()[1] as { currentTime: number }).currentTime);
  // The render Worker draws the new layout on its next render (later on a loaded machine).
  await expect.poll(() => framesOnWall(page, 1, 1), { timeout: 10_000 }).toEqual([covering(t2)]);
  await expect(page.locator('[data-otter-multiview-tile="1"]')).toBeHidden();
  // And back to the grid.
  await tile.dblclick(at);
  expect(await w.eval((x) => x.expanded())).toBe(-1);
  await expect(page.locator('[data-otter-multiview-tile="1"]')).toBeVisible();
  // Keyboard: Enter focuses, Shift+Enter expands.
  await page.locator('[data-otter-multiview-tile="3"]').focus();
  await page.keyboard.press('Enter');
  expect(await w.eval((x) => x.focused())).toBe(2);
  await page.keyboard.press('Shift+Enter');
  expect(await w.eval((x) => x.expanded())).toBe(2);
});

test('electronic zoom on a wall: Ctrl+wheel on a tile focuses and zooms that tile only', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(test.info().project.name.includes('iphone'), 'Playwright has no mouse wheel in mobile WebKit');
  await open(page, 4);
  const w = wall(page);
  const tile = page.locator('[data-otter-multiview-tile="2"]');
  const box = (await tile.boundingBox()) as { x: number; y: number; width: number; height: number };
  await tile.click({ position: { x: box.width * 0.85, y: box.height * 0.6 } });
  expect(await w.eval((x) => x.focused())).toBe(1);
  // Over the tile, clear of the centre buttons (small players put them over the tiles).
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.6);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect.poll(() => w.eval((x) => x.shellState().picture?.zoom ?? 1)).toBeGreaterThan(1.2);
  // The focused tile's view got the zoom; the others did not.
  const zooms = await page.evaluate(async () => {
    const x = await (window.wall as Promise<WallFixture>);
    return x.viewZooms();
  });
  expect(zooms[1]).toBeGreaterThan(1.2);
  expect([zooms[0], zooms[2], zooms[3]]).toEqual([1, 1, 1]);
  // Moving the focus starts the next tile from the original picture.
  await page.locator('[data-otter-multiview-tile="1"]').click({ position: { x: 20, y: box.height * 0.6 } });
  await expect.poll(() => w.eval((x) => x.shellState().picture?.zoom ?? 1)).toBe(1);
});

test('every viewport of the shared canvas shows its own stream', async ({ page }, info) => {
  test.setTimeout(120_000);
  await open(page, 4);
  const w = wall(page);
  await page.waitForTimeout(1500);
  // Paused at four different positions (off keyframes), each viewport must show its own.
  await page.evaluate(async () => {
    const x = await (window.wall as Promise<WallFixture>);
    x.tiles().forEach((_, i) => x.dispatchTo(i, 'pause'));
    await Promise.all(x.tiles().map((_, i) => x.seekTile(i, 0.9 + i * 2.13)));
  });
  const times = await w.eval((x) => x.tiles().map((t) => t.currentTime));
  expect(new Set(times.map(covering)).size).toBe(4);
  await expect.poll(() => framesOnWall(page, 2, 2), { timeout: 10_000 }).toEqual(times.map(covering));
  ciNotice(`multiview 4 tiles on ${await w.eval((x) => x.kind)}: each viewport shows its own stream (${info.project.name})`);
});

test('without WebGL2 a wall takes 4 streams and refuses more with gpuUnavailable', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/player.html?multiview=6&idle=0');
  const kind = await page.evaluate(async () => (await (window.wall as Promise<WallFixture>)).kind);
  test.skip(kind === 'gpu', 'WebGL2 here: the 2D limit does not apply');
  const r = await page.evaluate(async () => {
    const w = await (window.wall as Promise<WallFixture>);
    return { tiles: w.tiles().length, refused: [...w.refused] };
  });
  expect(r).toEqual({ tiles: 4, refused: ['gpuUnavailable'] });
  ciNotice('multiview without WebGL2: 4 tiles, the 5th refused (gpuUnavailable)');
});

test('a 17th stream waits for a decoder slot, says why, and starts when one frees', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/player.html?multiview=1&idle=0');
  test.skip((await page.evaluate(async () => (await (window.wall as Promise<WallFixture>)).kind)) !== 'gpu', 'no WebGL2: walls stop at 4 streams');
  await open(page, 17);
  const w = wall(page);
  // Whichever stream asked last waits (17 load at once): exactly one, told why.
  const tiles = await w.eval((x) => x.tiles());
  const waiting = tiles.filter((t) => t.status === 'loading');
  expect(waiting).toHaveLength(1);
  const queued = waiting[0] as (typeof tiles)[number];
  expect(queued.errors).toContain('decoderQueued');
  expect(queued.route?.steps.map((s) => s.reason)).toContainEqual(expect.stringMatching(/^decoder queued: 16 decoders busy \(pool limit\)/));
  expect((await w.eval((x) => x.pool())).queued).toBe(1);
  // A stream leaves: the waiting one gets its decoder and plays.
  const index = tiles.indexOf(queued);
  await w.eval((x) => x.remove(x.tiles().findIndex((t) => t.status === 'ready')));
  await expect.poll(() => w.eval((x) => x.tiles().every((t) => t.status === 'ready')), { timeout: 30_000 }).toBe(true);
  expect((await w.eval((x) => x.pool())).queued).toBe(0);
  void index;
});
