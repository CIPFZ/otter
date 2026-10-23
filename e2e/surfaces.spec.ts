// Electronic zoom and filters behave the same on every Surface (ADR-008 §6, M4 acceptance): the
// same paused frame on VideoSurface (CSS transform + CSS / SVG filter), GPUSurface (WebGL2 shader)
// and CanvasSurface (2D), compared pixel by pixel from screenshots.

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { SurfacesFixture } from './site/surfaces.ts';

interface Diff {
  /** Mean absolute difference per channel, 0..255. */
  readonly mean: number;
  /** Share of pixels off by more than 40 on some channel. */
  readonly outliers: number;
}

/**
 * One screenshot of the boxes; each other box is compared with the video box in the page (no
 * pixel arrays through the protocol). No colour map: the frame surfaces colour-manage like the
 * platform's <video> (ADR-011 §3), so the pixels compare as they are.
 */
async function compareBoxes(page: Page, others: readonly string[]): Promise<Record<string, Diff & { samples: number[][] }>> {
  // Full page: on a phone viewport the third box sits below the fold.
  const png = (await page.screenshot({ animations: 'disabled', fullPage: true })).toString('base64');
  return page.evaluate(
    async ([b64, ids]) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      // The screenshot is in device pixels (its width is rounded, so img.width / clientWidth is
      // not exact: 1081 / 412 on a Pixel 7 would crop the lower boxes a pixel off).
      const ratio = devicePixelRatio;
      const grab = (id: string): ImageData => {
        const r = (document.getElementById(id) as HTMLElement).getBoundingClientRect();
        return ctx.getImageData(Math.round(r.x * ratio), Math.round(r.y * ratio), Math.round(r.width * ratio), Math.round(r.height * ratio));
      };
      const samples = (d: ImageData): number[][] =>
        [0.08, 0.22, 0.4, 0.55, 0.72, 0.9].map((fx) => {
          const i = (Math.round(0.6 * d.height) * d.width + Math.round(fx * d.width)) * 4;
          return [d.data[i] as number, d.data[i + 1] as number, d.data[i + 2] as number];
        });
      const video = grab('video-box');
      const out: Record<string, { mean: number; outliers: number; samples: number[][] }> = {};
      for (const id of ids) {
        const other = grab(id);
        let sum = 0;
        let outliers = 0;
        const n = Math.min(video.data.length, other.data.length) / 4;
        for (let i = 0; i < n; i++) {
          let worst = 0;
          for (let ch = 0; ch < 3; ch++) {
            const d = Math.abs((video.data[i * 4 + ch] as number) - (other.data[i * 4 + ch] as number));
            sum += d;
            if (d > worst) worst = d;
          }
          if (worst > 40) outliers++;
        }
        out[id] = { mean: sum / (n * 3), outliers: outliers / n, samples: [...samples(video), ...samples(other)] };
      }
      return out;
    },
    [png, others] as const,
  );
}

// Resampling and YUV conversion differ slightly between paths; edges of a sharpened, zoomed test
// pattern are the worst case.
const MAX_MEAN = 6;
const MAX_OUTLIERS = 0.03;
const within = (d: Diff): boolean => d.mean < MAX_MEAN && d.outliers < MAX_OUTLIERS;

/** One line for the CI run page (the workflow turns test-results/ci-notices.txt into notices). */
const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const CASES: [string, Parameters<SurfacesFixture['apply']>[0], Parameters<SurfacesFixture['apply']>[1]][] = [
  ['identity', {}, {}],
  ['zoom 2x + pan', { zoom: 2, pan: [30, -20] }, {}],
  ['rotate 90 + mirror', { zoom: 1, pan: [0, 0], rotate: 90, mirror: true }, {}],
  ['brightness / contrast / saturate', { rotate: 0, mirror: false }, { brightness: 1.3, contrast: 0.8, saturate: 1.6 }],
  ['temperature warm', {}, { brightness: 1, contrast: 1, saturate: 1, temperature: 0.8 }],
  ['sharpen', {}, { temperature: 0, sharpen: 0.6 }],
  ['zoom 3x + all filters', { zoom: 3, pan: [0, 0] }, { brightness: 0.9, contrast: 1.2, saturate: 0.5, temperature: -0.6, sharpen: 0.3 }],
];

test('zoom and filters: VideoSurface, GPUSurface and CanvasSurface draw the same picture', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto('/surfaces.html');
  const gpu = await page.evaluate(async () => (await (window.surfaces as Promise<SurfacesFixture>)).gpu);
  await page.evaluate(async () => (await (window.surfaces as Promise<SurfacesFixture>)).frame(2.3));
  const results: Record<string, Diff> = {};
  // Controls, so a black or frozen picture cannot pass: the frame has content, and a different
  // frame on the frame surfaces is clearly different from the video.
  const control = await page.evaluate(async () => {
    const v = document.querySelector('video') as HTMLVideoElement;
    const c = new OffscreenCanvas(64, 48);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(v, 0, 0, 64, 48);
    const d = ctx.getImageData(0, 0, 64, 48).data;
    const lum = Array.from({ length: d.length / 4 }, (_, i) => (d[i * 4] as number) + (d[i * 4 + 1] as number) + (d[i * 4 + 2] as number));
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
    return Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length);
  });
  expect(control, 'the test frame has detail').toBeGreaterThan(40);
  await page.evaluate(async () => {
    const s = await (window.surfaces as Promise<SurfacesFixture>);
    await s.frame(6.1);
    // Put the video back on the 2.3 s frame without redrawing the frame surfaces.
    await s.seekVideo(2.3);
  });
  for (const [box, diff] of Object.entries(await compareBoxes(page, gpu ? ['gpu-box', 'canvas2d-box'] : ['canvas2d-box']))) {
    expect(diff.mean, `control: another frame on ${box} must differ`).toBeGreaterThan(10);
  }
  await page.evaluate(async () => (await (window.surfaces as Promise<SurfacesFixture>)).frame(2.3));
  const boxes = gpu ? ['gpu-box', 'canvas2d-box'] : ['canvas2d-box'];
  // What the platform says about the frame and its drawing paths, for the CI notice.
  const probe = await page.evaluate(async () => (await (window.surfaces as Promise<SurfacesFixture>)).colourManaged());
  const samples: Record<string, number[][]> = {};
  const passed: Record<string, boolean> = {};
  for (const [name, t, f] of CASES) {
    await page.evaluate(async ([tt, ff]) => (await (window.surfaces as Promise<SurfacesFixture>)).apply(tt, ff), [t, f] as const);
    const rects = await page.evaluate(async () => (await (window.surfaces as Promise<SurfacesFixture>)).rects());
    // The picture rectangle (what overlays use) is the same on every surface.
    for (const r of Object.values(rects)) expect(r).toEqual(rects['video']);
    // Compositors may show a new transform / filter a few frames late (WebKit): compare the
    // settled picture, up to 2 s.
    let diffs = await compareBoxes(page, boxes);
    for (let i = 0; i < 10 && !Object.values(diffs).every(within); i++) {
      await page.waitForTimeout(200);
      diffs = await compareBoxes(page, boxes);
    }
    for (const [box, diff] of Object.entries(diffs)) {
      results[`${name} ${box}`] = { mean: diff.mean, outliers: diff.outliers };
      passed[`${name} ${box}`] = within(diff);
      samples[`${name} ${box}`] = diff.samples;
      expect.soft(diff.mean, `${name}: ${box} vs video`).toBeLessThan(MAX_MEAN);
      expect.soft(diff.outliers, `${name}: ${box} vs video`).toBeLessThan(MAX_OUTLIERS);
    }
  }
  const ok = Object.values(passed).every(Boolean);
  if (!ok) {
    // For engines we cannot run locally (WebKit): bar colours (video box first, then the
    // surface) per case, on the CI run page.
    ciNotice(`surfaces diagnostics ${JSON.stringify({ samples })}`);
  }
  const worst = Object.values(results).reduce((w, d) => ({ mean: Math.max(w.mean, d.mean), outliers: Math.max(w.outliers, d.outliers) }), { mean: 0, outliers: 0 });
  const platform = `probe 2D ${probe.canvas2d.map(Math.round).join(',')} vs WebGL ${probe.webgl.map(Math.round).join(',')}; frame ${JSON.stringify(probe.frame)}, renderer ${probe.renderer}, synthetic 170M red 2D ${probe.synthetic.canvas2d.join(',')} WebGL ${probe.synthetic.webgl.join(',')}`;
  ciNotice(`surfaces: worst mean ${worst.mean.toFixed(2)}, outliers ${(worst.outliers * 100).toFixed(2)}%; ${platform}; ${ok ? '' : 'FAILED '}${Object.entries(results).map(([k, d]) => `${k} ${d.mean.toFixed(1)}/${(d.outliers * 100).toFixed(1)}%`).join(', ')}`);
  info.annotations.push({ type: 'surface-diff', description: JSON.stringify(results) });
  test.info().attach('surface-diff.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
});
