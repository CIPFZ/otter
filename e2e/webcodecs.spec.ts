// format-file + backend-webcodecs + decoder-webcodecs (ADR-008 §2, M4): the fixture clips paint
// their own frame number as ten 48 px blocks (generate-frames.sh), so every check reads the
// picture itself. The frame shown at t is the last one starting at or before t (frame k for
// t in [k/30, (k+1)/30), like <video>), decoded from the keyframe before it (every 90 frames).

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

// Targets: frame starts and points inside frames (below half a frame, where round(t × fps) is the
// frame), all off keyframes and most far from the keyframe before them, out of order.
const CLIPS = [
  // H.264 in MP4 with AAC: audio on the AudioWorklet, video aligned to the same clock.
  { name: 'h264.mp4', seeks: [129 / FPS, 4.3, 139 / FPS, (170 + 0.4) / FPS, (59 + 0.15) / FPS, 1 / FPS, 359 / FPS] },
  // No audio track: still the AudioContext clock.
  { name: 'h264-video-only.mp4', seeks: [2.2, 91 / FPS, (89 + 0.3) / FPS, 7.01, 268 / FPS] },
  // VP9 in WebM with Opus. WebM stores milliseconds: frame 32 starts at 1.067, after 32 / 30.
  { name: 'vp9.webm', seeks: [1.04, (179 + 0.2) / FPS, 32 / FPS, 5.5, (269 + 0.4) / FPS, 47 / FPS] },
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
      const expected = Math.round(t * FPS);
      expect(t * FPS - Math.floor(t * FPS + 1e-9), `fixture: ${t} is in the first half of its frame`).toBeLessThan(0.5);
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
    ciNotice(`${clip.name} on ${surface}: ${clip.seeks.length} seeks frame-exact, slowest ${Math.round(Math.max(...times))} ms`);
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
    expect(await frameOnCanvas(page)).toBe(Math.floor(s.currentTime * FPS + 1e-6));
  });
}
