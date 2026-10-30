// format-file + backend-webcodecs + decoder-webcodecs (ADR-008 §2, M4): the fixture clips paint
// their own frame number as ten 48 px blocks (generate-frames.sh), so every check reads the
// picture itself. The frame shown at t is the one covering t: floor(t × fps), the last frame
// starting at or before t (like <video>), decoded from the keyframe before it (every 90 frames).

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { WebCodecsFixture } from './site/webcodecs.ts';

const FPS = 30;
const GOP = 90;

/** One line for the CI run page (the workflow turns test-results/ci-notices.txt into notices). */
const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

/**
 * Reads the frame number out of the canvas: bit i is the 48 px block at x = 48 i of the 640x360
 * picture, sampled at its centre (as fractions of the canvas, so any device pixel ratio works).
 */
async function frameOnCanvas(page: Page): Promise<number> {
  const png = (await page.locator('#canvas').screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    let bits = 0;
    for (let i = 0; i < 10; i++) {
      const d = ctx.getImageData(Math.floor(((i * 48 + 24) / 640) * img.width), Math.floor((24 / 360) * img.height), 1, 1).data;
      if ((d[0] as number) + (d[1] as number) + (d[2] as number) > 384) bits |= 1 << i;
    }
    return bits;
  }, png);
}

interface Loaded {
  readonly status: string;
  readonly route: { format: string | null; backend: string | null; steps: { candidate: string; outcome: string; reason: string }[] } | null;
  readonly error: unknown;
}

/** The frame covering t: the last one starting at or before it (ε absorbs float error). */
const covering = (t: number): number => Math.floor(t * FPS + 1e-6);

// Targets, out of order and all off keyframes (most far from the keyframe before them): frame
// starts, points in the first half of a frame, and points in its second half, where the frame
// covering t is still the current one, not the next (round(t × fps) would be the next). WebM
// stores milliseconds (frame 32 starts at 1.067, after 32 / 30), so no target sits within 1 ms
// of the next frame's start.
const CLIPS = [
  // H.264 in MP4 with AAC: audio on the AudioWorklet, video aligned to the same clock.
  { name: 'h264.mp4', seeks: [129 / FPS, 4.3, (139 + 0.75) / FPS, (170 + 0.4) / FPS, (59 + 0.6) / FPS, 1 / FPS, (200 + 0.95) / FPS, 359 / FPS, (88 + 0.85) / FPS] },
  // No audio track: still the AudioContext clock.
  { name: 'h264-video-only.mp4', seeks: [2.2, (91 + 0.7) / FPS, (89 + 0.3) / FPS, 7.01, (268 + 0.9) / FPS, (100 + 0.55) / FPS] },
  // VP9 in WebM with Opus.
  { name: 'vp9.webm', seeks: [1.04, (179 + 0.2) / FPS, 32 / FPS, (45 + 0.8) / FPS, 5.5, (269 + 0.4) / FPS, (150 + 0.65) / FPS, 47 / FPS, (230 + 0.75) / FPS] },
];

for (const clip of CLIPS) {
  test(`${clip.name}: frame-accurate seek, frame number read from the picture`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/webcodecs.html');
    const loaded = (await page.evaluate(async (name) => (await (window.wc as Promise<WebCodecsFixture>)).load(name), clip.name)) as Loaded;
    expect(loaded.status, JSON.stringify(loaded.error)).toBe('ready');
    expect(loaded.route?.format).toBe('file');
    expect(loaded.route?.backend).toBe('webcodecs');
    expect(loaded.route?.steps).toContainEqual({ candidate: 'platform', outcome: 'selected', reason: 'format only feeds WebCodecs' });
    expect(await frameOnCanvas(page), 'first picture').toBe(0);

    const times: number[] = [];
    for (const t of clip.seeks) {
      const expected = covering(t);
      // Off keyframes: the decoder had to start earlier and drop frames.
      expect(expected % GOP, `fixture: ${t} is not on a keyframe`).not.toBe(0);
      times.push(await page.evaluate(async (time) => (await (window.wc as Promise<WebCodecsFixture>)).seek(time), t));
      expect({ t, frame: await frameOnCanvas(page) }).toEqual({ t, frame: expected });
      const s = await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).state());
      expect(s).toMatchObject({ seeking: false, paused: true });
      expect(s.currentTime).toBeCloseTo(t, 6);
    }
    const s = await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).state());
    expect(s).toMatchObject({ backend: 'webcodecs', format: 'file' });
    expect(s.duration).toBeCloseTo(12, 1);
    const surface = await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).surface);
    const late = clip.seeks.filter((t) => t * FPS - covering(t) >= 0.5).length;
    expect(late, 'fixture: some targets in the second half of a frame').toBeGreaterThanOrEqual(3);
    ciNotice(`${clip.name} on ${surface}: ${clip.seeks.length} seeks frame-exact (${late} in a frame's second half), slowest ${Math.round(Math.max(...times))} ms`);
  });

  test(`${clip.name}: plays on the AudioContext clock, the picture follows it`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/webcodecs.html');
    await page.evaluate(async (name) => (await (window.wc as Promise<WebCodecsFixture>)).load(name, 6), clip.name);
    // A real click: play() runs inside a user gesture, so the AudioContext may start.
    await page.locator('#play').click();
    const audioRuns = await page.evaluate(async () => {
      const c = new AudioContext();
      const ran = await Promise.race([c.resume().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1000))]);
      const t0 = c.currentTime;
      await new Promise((r) => setTimeout(r, 200));
      const ok = ran && c.state === 'running' && c.currentTime > t0;
      void c.close().catch(() => undefined);
      return ok;
    });
    const run = await page.evaluate(async () => {
      const f = await (window.wc as Promise<WebCodecsFixture>);
      const t0 = performance.now();
      const before = f.state().currentTime;
      const frames: number[] = [];
      while (performance.now() - t0 < 1500) {
        await new Promise((r) => setTimeout(r, 100));
        frames.push(f.state().currentTime);
      }
      const errors = f.events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string; message?: string } }).error);
      return {
        advanced: f.state().currentTime - before,
        frames,
        events: f.events.map((e) => e.type),
        errors: errors.map((e) => e.details),
        messages: errors.map((e) => String(e.message)),
      };
    });
    // Media time advanced with wall time (1.5 s sampled, slack for the first frames and the click).
    expect(run.advanced).toBeGreaterThan(1.1);
    expect(run.advanced).toBeLessThan(2.2);
    expect([...run.frames].sort((a, b) => a - b)).toEqual(run.frames);
    expect(run.events).toContain('startup');
    expect(run.events).not.toContain('rebuffer');
    // Where an AudioContext can run it is the clock; where it cannot (headless Firefox on Linux:
    // resume() never settles) playback keeps time on performance.now() and says so, once.
    if (audioRuns) {
      expect(run.errors, JSON.stringify(run.messages)).toEqual([]);
    } else {
      // Reported once resume() has had its 3 s grace (RESUME_GRACE_MS), not before.
      await expect
        .poll(async () => page.evaluate(async () => ((await (window.wc as Promise<WebCodecsFixture>)).events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string } }).error.details))), { timeout: 5000 })
        .toEqual(['audioClockUnavailable']);
      ciNotice(`${clip.name}: no running AudioContext here; played on performance.now(), reported as audioClockUnavailable`);
    }
    // Paused, the picture is the frame of the clock's position.
    await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).dispatch('pause', undefined));
    await page.waitForTimeout(100);
    const s = await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).state());
    expect(s.paused).toBe(true);
    // Same rule as seeking, including the backend's 0.5 ms tolerance at frame starts (WebM
    // stores milliseconds; Firefox's clock moves in whole milliseconds, so a pause can land there).
    expect(await frameOnCanvas(page)).toBe(covering(s.currentTime + 0.0005));
  });
}

// The shared AudioContext suspends 5 s after the last instance stops playing (clock.ts) and is
// resumed by the next play() in a user gesture: the clock is the AudioContext again, not the
// performance.now() fallback. Real Firefox on Windows is where this path was unverified (M4).
// The audio worklet keeps producing sound for 30 s (M6 F12: a recording worklet stopped after
// about 2.7 s on the real Firefox; the product's own worklet is checked here). Its output is tapped
// by an AnalyserNode; the 12 s clip (a 440 Hz sine) is played from the start again near its end.
// OTTER_REPEAT_F14=<n>: the case n times in a row (the F14 acceptance: 5 on each CI browser).
for (let run = 1; run <= Number(process.env['OTTER_REPEAT_F14'] ?? 1); run++)
test(`h264.mp4 with sound for 30 s: the audio worklet keeps producing, every second${run > 1 ? ` (run ${run})` : ''} @solo`, async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const Native = window.AudioWorkletNode;
    type Stat = { at: number; media: number; ahead: number; queued: number; under: number; gap: number; late: number; disc: number; dq: number; wall: number };
    const w = window as unknown as { taps: AnalyserNode[]; stats: Stat[] };
    w.taps = [];
    w.stats = [];
    window.AudioWorkletNode = class extends Native {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        const tap = context.createAnalyser();
        this.connect(tap);
        w.taps.push(tap);
        // The sink's 0.2 s summaries (M6 F14 observation).
        this.port.addEventListener('message', (e: MessageEvent<{ t: string } & Omit<Stat, 'wall'>>) => {
          if (e.data.t === 'stat') w.stats.push({ ...e.data, wall: performance.now() });
        });
        this.port.start();
      }
    };
  });
  await page.goto('/webcodecs.html');
  await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).load('h264.mp4', 0));
  await page.locator('#play').click();
  const probe = () =>
    page.evaluate(async () => {
      const f = await (window.wc as Promise<WebCodecsFixture>);
      const tap = (window as unknown as { taps: AnalyserNode[] }).taps.at(-1);
      let rms = 0;
      if (tap !== undefined) {
        const d = new Float32Array(tap.fftSize);
        tap.getFloatTimeDomainData(d);
        rms = Math.sqrt(d.reduce((a, x) => a + x * x, 0) / d.length);
      }
      return { taps: (window as unknown as { taps: AnalyserNode[] }).taps.length, state: tap?.context.state ?? 'none', t: f.state().currentTime, muted: f.state().muted, rms, wall: performance.now() };
    });
  await expect.poll(async () => (await probe()).t, { timeout: 15_000 }).toBeGreaterThan(0.5);
  const first = await probe();
  if (first.taps === 0 || first.state !== 'running') {
    ciNotice(`audio worklet 30 s: ${first.taps === 0 ? 'no audio worklet' : `AudioContext ${first.state}`} here, not testable`);
    test.skip(true, 'no running audio worklet here');
  }
  // The context's own time every 20 ms: stretches of >= 0.5 s without movement are the audio
  // render thread standing still (M6 F14: the test instance's sound device; then process() is not
  // called at all and the output is silent), recorded as performance.now() spans.
  await page.evaluate(() => {
    const w = window as unknown as { taps: AnalyserNode[]; ctxStalls: { from: number; to: number }[]; loud: { at: number; rms: number }[] };
    const tap = w.taps.at(-1) as AnalyserNode;
    const ctx = tap.context;
    const buf = new Float32Array(tap.fftSize);
    w.ctxStalls = [];
    w.loud = [];
    let last = -1;
    let since = performance.now();
    let open: { from: number; to: number } | undefined;
    setInterval(() => {
      const now = performance.now();
      // The output every 20 ms: when sound comes back after a stall.
      tap.getFloatTimeDomainData(buf);
      w.loud.push({ at: now, rms: Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length) });
      if (ctx.currentTime !== last) {
        if (open !== undefined) open.to = now;
        open = undefined;
        last = ctx.currentTime;
        since = now;
      } else if (open === undefined && now - since >= 500) {
        open = { from: since, to: Infinity };
        w.ctxStalls.push(open);
      }
    }, 20);
  });
  const rms: number[] = [];
  const walls: number[] = [];
  const seeks: number[] = [];
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const p = await probe();
    rms.push(p.rms);
    walls.push(p.wall);
    if (p.t > 10.5) seeks.push(await page.evaluate(async () => {
      const at = performance.now();
      await (await (window.wc as Promise<WebCodecsFixture>)).seek(0.2);
      return at;
    }));
  }
  // Each silent second with the sink's summaries of the second before it (M6 F14). A silent second
  // inside a stall of the render thread (from 1 s before it to 500 ms after it) is the
  // environment's: noted, not counted.
  const stallSpans = await page.evaluate(() => (window as unknown as { ctxStalls: { from: number; to: number }[] }).ctxStalls.map((x) => ({ from: x.from, to: Number.isFinite(x.to) ? x.to : Number.MAX_VALUE })));
  const inStall = (i: number): boolean => stallSpans.some((x) => (walls[i] as number) - 1000 <= x.to + 500 && (walls[i] as number) >= x.from);
  const silent = rms.flatMap((x, i) => (x < 0.01 ? [i] : []));
  const environment = silent.filter(inStall);
  // After each stall that ended, sound within 100 ms of the context moving again (M6: it used to
  // wait for the clock's 2 s switch back).
  const loud = await page.evaluate(() => (window as unknown as { loud: { at: number; rms: number }[] }).loud);
  const back = stallSpans
    .filter((x) => x.to < Number.MAX_VALUE && x.to < (walls.at(-1) as number) - 500)
    .map((x) => {
      const first = loud.find((l) => l.at >= x.to && l.rms > 0.01);
      return first === undefined ? Infinity : first.at - x.to;
    });
  if (back.length > 0) ciNotice(`audio worklet 30 s: sound back ${back.map((ms) => `${Math.round(ms)} ms`).join(', ')} after the context moved again`);
  for (const ms of back) expect(ms, 'sound back within 100 ms of the context moving again').toBeLessThanOrEqual(100);
  if (environment.length > 0) ciNotice(`audio worklet 30 s: 环境停顿 (render thread stood still ${stallSpans.map((x) => `${((x.to - x.from) / 1000).toFixed(2)} s`).join(', ')}): silent seconds ${environment.join(', ')} not counted`);
  const all = await page.evaluate(() => (window as unknown as { stats: { ahead: number; under: number; gap: number; late: number; disc: number }[] }).stats);
  ciNotice(
    `audio worklet 30 s, sink summary: ${all.length} windows, lowest ahead ${Math.min(...all.map((x) => x.ahead)).toFixed(2)} s, zeroed samples dry ${all.reduce((n, x) => n + x.under, 0)} / gap ${all.reduce((n, x) => n + x.gap, 0)}, late chunks ${all.reduce((n, x) => n + x.late, 0)}, largest discontinuity ${Math.max(...all.map((x) => Math.abs(x.disc))).toFixed(3)} s, ${seeks.length} seeks`,
  );
  if (silent.length > 0) {
    const stats = await page.evaluate(() => (window as unknown as { stats: { at: number; media: number; ahead: number; queued: number; under: number; gap: number; late: number; disc: number; dq: number; wall: number }[] }).stats);
    const lines = silent.map((i) => {
      const to = walls[i] as number;
      const from = to - 1000;
      const near = stats.filter((x) => x.wall >= from - 400 && x.wall <= to + 200);
      const seekNear = seeks.filter((x) => x >= from - 1500 && x <= to).map((x) => `seek ${Math.round(to - x)} ms before`);
      return `second ${i} (${seekNear.join(', ') || 'no seek'}): ${near.map((x) => `[media ${x.media.toFixed(2)} ahead ${x.ahead.toFixed(2)} q ${x.queued} under ${x.under} gap ${x.gap} late ${x.late} disc ${x.disc.toFixed(3)} dq ${x.dq}]`).join(' ')}`;
    });
    ciNotice(`audio worklet 30 s: silent seconds with the sink's view: ${lines.join(' | ')}`);
  }
  ciNotice(`audio worklet 30 s: RMS per second min ${Math.min(...rms).toFixed(3)}, max ${Math.max(...rms).toFixed(3)}; ${rms.filter((x) => x < 0.01).length} silent seconds`);
  // Known issue on CI's emulated Android (M6 F14, owner 2026-10-29: M7, a real phone decides): the
  // decoder's output falls behind real time, the pump waits at the decode queue's cap (dq 17) and
  // the sink runs dry. A silent second there with exactly that in the sink's view (dry, ahead < 0,
  // dq at the cap) is noted as the known issue, not counted; anything else still fails.
  const sinkStats = await page.evaluate(() => (window as unknown as { stats: { ahead: number; under: number; dq: number; wall: number }[] }).stats);
  const knownIssue = (i: number): boolean =>
    info.project.name === 'emulated-android' && sinkStats.some((x) => x.wall >= (walls[i] as number) - 1400 && x.wall <= (walls[i] as number) + 200 && x.ahead < 0 && x.under > 0 && x.dq >= 17);
  const known = silent.filter((i) => !environment.includes(i) && knownIssue(i));
  if (known.length > 0) {
    info.annotations.push({ type: 'issue', description: `M6 F14 known issue (emulated Android): silent seconds ${known.join(', ')} with the decode queue at its cap and the sink dry` });
    ciNotice(`audio worklet 30 s: F14 已知问题 (emulated Android, decode queue at its cap, sink dry): silent seconds ${known.join(', ')} not counted`);
  }
  expect(first.muted).toBe(false);
  expect(silent.filter((i) => !environment.includes(i) && !known.includes(i)), `silent seconds outside an environment stall (RMS ${rms.map((x) => x.toFixed(3)).join(' ')})`).toEqual([]);
  // A dry sink is reported, not silent (none expected here).
  const underruns = await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).events.filter((e) => e.type === 'error' && (e.payload as { error: { details: string } }).error.details === 'audioUnderrun').map((e) => (e.payload as { error: { message?: string } }).error.message ?? ''));
  // The dry sink of the known issue says so (audioUnderrun): only there.
  expect(known.length > 0 ? [] : underruns).toEqual([]);
});

test('h264.mp4: after 6 s paused the AudioContext is suspended; play resumes it as the clock', async ({ page }) => {
  test.setTimeout(60_000);
  // Records the AudioContexts the page makes, to read their state.
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    const made: AudioContext[] = [];
    (window as unknown as { contexts: AudioContext[] }).contexts = made;
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        made.push(this);
      }
    };
  });
  await page.goto('/webcodecs.html');
  await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).load('h264.mp4', 1));
  await page.locator('#play').click();
  const states = () => page.evaluate(() => (window as unknown as { contexts: AudioContext[] }).contexts.map((c) => c.state));
  await expect.poll(async () => (await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).state().currentTime)), { timeout: 15_000 }).toBeGreaterThan(1.5);
  if (!(await states()).includes('running')) {
    ciNotice('no running AudioContext here: idle suspend / resume not testable');
    return;
  }
  await page.locator('#play').click();
  await page.waitForTimeout(6000);
  expect(await states()).not.toContain('running');
  const before = await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).state().currentTime);
  // What the context does after the resuming click (state, currentTime every 50 ms), for the
  // notice: when it says running, and when its time starts to move (ADR-008 §2).
  await page.evaluate(() => {
    const w = window as unknown as { contexts: AudioContext[]; ctxTrace: string[] };
    const c = w.contexts[0] as AudioContext;
    const t0 = performance.now();
    w.ctxTrace = [];
    let last = '';
    const id = setInterval(() => {
      const ms = Math.round(performance.now() - t0);
      const now = `${c.state} ${c.currentTime.toFixed(3)}`;
      if (now !== last) w.ctxTrace.push(`${ms}ms ${now}`);
      last = now;
      if (ms > 1500) clearInterval(id);
    }, 50);
  });
  await page.locator('#play').click();
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async () => {
    const f = await (window.wc as Promise<WebCodecsFixture>);
    const errors = f.events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string; message?: string } }).error);
    return { t: f.state().currentTime, paused: f.state().paused, errors: errors.map((e) => e.details), messages: errors.map((e) => `${e.details}: ${e.message ?? ''}`) };
  });
  // Which way the clock fell back (suspended context / frozen time), for an occasional failure;
  // the context's trace after the click either way (first 12 changes).
  const trace = await page.evaluate(() => (window as unknown as { ctxTrace: string[] }).ctxTrace.slice(0, 12));
  ciNotice(`AudioContext resume: ${r.errors.length > 0 ? JSON.stringify(r.messages) : 'no clock fallback'}, ${(r.t - before).toFixed(2)} s played in 1.5 s; context ${trace.join(' | ')}`);
  expect(await states()).toContain('running');
  expect(r.paused).toBe(false);
  expect(r.t - before).toBeGreaterThan(1);
  expect(r.t - before).toBeLessThan(2);
  expect(r.errors).toEqual([]);
  ciNotice(`AudioContext idle suspend after 6 s paused, resumed by play: ${(r.t - before).toFixed(2)} s played in 1.5 s, no audioClockUnavailable`);
});

for (const build of ['simd', 'plain'] as const) {
test(`hevc-720p.mp4 (${build} WASM build): no HEVC in WebCodecs here, so the route falls back to the WASM decoder in the pool`, async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(build === 'plain' ? '/webcodecs.html?simd=0' : '/webcodecs.html');
  const simdHere = await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).wasm.simd);
  if (build === 'simd' && !simdHere) ciNotice('no WebAssembly SIMD here: the SIMD case runs the plain build');
  const loaded = (await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).load('hevc-720p.mp4'))) as Loaded;
  expect(loaded.status, JSON.stringify(loaded.error)).toBe('ready');
  const steps = loaded.route?.steps ?? [];
  if (loaded.route?.backend === 'webcodecs') {
    // A browser with HEVC in WebCodecs (hardware) needs no fallback.
    ciNotice('hevc-720p.mp4: WebCodecs decodes HEVC here, no WASM fallback');
  } else {
    expect(loaded.route?.backend).toBe('wasm');
    expect(steps).toContainEqual({ candidate: 'webcodecs', outcome: 'failed', reason: 'codecUnsupported' });
    expect(steps).toContainEqual({ candidate: 'wasm', outcome: 'selected', reason: 'fallback after webcodecs' });
    // How the WASM step runs is part of router.explain().
    const detail = steps.find((s) => s.candidate === 'wasm' && /jv4-decoder/.test(s.reason));
    expect(detail?.reason).toMatch(build === 'plain' || !simdHere ? /FFmpeg \(no SIMD\)/ : /libhevc\/libavc \(SIMD\)/);
    expect(detail?.reason).toMatch(/crossOriginIsolated (true|false)/);
  }
  expect(await frameOnCanvas(page), 'first picture').toBe(0);
  const times: number[] = [];
  // GOP 60, no B-frames: targets off keyframes, both halves of frames.
  for (const t of [(97 + 0.3) / FPS, 4.9, (61 + 0.8) / FPS, (179 + 0.6) / FPS, 1 / FPS]) {
    times.push(await page.evaluate(async (time) => (await (window.wc as Promise<WebCodecsFixture>)).seek(time), t));
    expect({ t, frame: await frameOnCanvas(page) }).toEqual({ t, frame: covering(t) });
  }
  const pool = await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).pool());
  const wasm = await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).wasm);
  const video = pool.slots.find((s) => s.frames > 0);
  // Decoded in a pool Worker, not on the main thread.
  expect(video?.worker).toBeGreaterThanOrEqual(0);
  if (loaded.route?.backend === 'wasm') expect(video?.kind).toMatch(/^jv4-decoder/);
  ciNotice(`hevc-720p.mp4 via ${loaded.route?.backend} (${wasm.build}, crossOriginIsolated ${wasm.crossOriginIsolated}): 5 seeks frame-exact, slowest ${Math.round(Math.max(...times))} ms, ${video?.frames} frames in worker ${video?.worker}, ${Math.round(video?.busyMs ?? 0)} ms decoding`);
});
}
