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
      expect(run.errors).toEqual(['audioClockUnavailable']);
      ciNotice(`${clip.name}: no running AudioContext here; played on performance.now(), reported as audioClockUnavailable`);
    }
    // Paused, the picture is the frame of the clock's position.
    await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).dispatch('pause', undefined));
    await page.waitForTimeout(100);
    const s = await page.evaluate(async () => (await (window.wc as Promise<WebCodecsFixture>)).state());
    expect(s.paused).toBe(true);
    expect(await frameOnCanvas(page)).toBe(covering(s.currentTime));
  });
}

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
