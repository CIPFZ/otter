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

/** Row-major 3x4 colour map (rgb + offset per output channel), applied before comparing. */
type ColorFit = number[];

/**
 * One screenshot of the boxes; each other box is compared with the video box in the page (no
 * pixel arrays through the protocol), after mapping its colours with `fits[id]`. With `fit`
 * set, returns instead the least-squares colour map from each box to the video box: the
 * platform's own colour handling (WebKit colour-manages <video> and 2D canvas but not WebGL
 * uploads), measured once on the unfiltered frame.
 */
async function compareBoxes(page: Page, others: readonly string[], fits: Record<string, ColorFit> = {}, fit = false): Promise<Record<string, Diff & { fit: ColorFit; samples: number[][] }>> {
  // Full page: on a phone viewport the third box sits below the fold.
  const png = (await page.screenshot({ animations: 'disabled', fullPage: true })).toString('base64');
  return page.evaluate(
    async ([b64, ids, maps, solve]) => {
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
      /** Least squares: video ≈ M [r g b 1] over all pixels (normal equations, 4x4 solve). */
      const fitMap = (from: ImageData, to: ImageData): number[] => {
        const ata = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
        const aty = Array.from({ length: 4 }, () => [0, 0, 0]);
        const n = Math.min(from.data.length, to.data.length) / 4;
        for (let i = 0; i < n; i++) {
          const x = [from.data[i * 4] as number, from.data[i * 4 + 1] as number, from.data[i * 4 + 2] as number, 255];
          for (let r = 0; r < 4; r++) {
            for (let k = 0; k < 4; k++) (ata[r] as number[])[k] = ((ata[r] as number[])[k] as number) + (x[r] as number) * (x[k] as number);
            for (let ch = 0; ch < 3; ch++) (aty[r] as number[])[ch] = ((aty[r] as number[])[ch] as number) + (x[r] as number) * (to.data[i * 4 + ch] as number);
          }
        }
        // Gauss-Jordan on [ata | aty].
        const m = ata.map((row, r) => [...row, ...(aty[r] as number[])]);
        for (let col = 0; col < 4; col++) {
          let pivot = col;
          for (let r = col + 1; r < 4; r++) if (Math.abs((m[r] as number[])[col] as number) > Math.abs((m[pivot] as number[])[col] as number)) pivot = r;
          [m[col], m[pivot]] = [m[pivot] as number[], m[col] as number[]];
          const p = (m[col] as number[])[col] as number;
          if (Math.abs(p) < 1e-9) continue;
          m[col] = (m[col] as number[]).map((v) => v / p);
          for (let r = 0; r < 4; r++) {
            if (r === col) continue;
            const f = (m[r] as number[])[col] as number;
            m[r] = (m[r] as number[]).map((v, k) => v - f * ((m[col] as number[])[k] as number));
          }
        }
        // Row-major 3x4: out channel ch = sum_k M[ch][k] x_k, offset in 0..255 units (x_3 = 255).
        return [0, 1, 2].flatMap((ch) => [0, 1, 2, 3].map((k) => (k === 3 ? 255 : 1) * ((m[k] as number[])[4 + ch] as number)));
      };
      const video = grab('video-box');
      const out: Record<string, { mean: number; outliers: number; fit: number[]; samples: number[][] }> = {};
      for (const id of ids) {
        const other = grab(id);
        const fitted = solve ? fitMap(other, video) : (maps[id] ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
        let sum = 0;
        let outliers = 0;
        const n = Math.min(video.data.length, other.data.length) / 4;
        for (let i = 0; i < n; i++) {
          const r = other.data[i * 4] as number;
          const g = other.data[i * 4 + 1] as number;
          const b = other.data[i * 4 + 2] as number;
          let worst = 0;
          for (let ch = 0; ch < 3; ch++) {
            const mapped = Math.min(255, Math.max(0, (fitted[ch * 4] as number) * r + (fitted[ch * 4 + 1] as number) * g + (fitted[ch * 4 + 2] as number) * b + (fitted[ch * 4 + 3] as number)));
            const d = Math.abs((video.data[i * 4 + ch] as number) - mapped);
            sum += d;
            if (d > worst) worst = d;
          }
          if (worst > 40) outliers++;
        }
        out[id] = { mean: sum / (n * 3), outliers: outliers / n, fit: fitted, samples: [...samples(video), ...samples(other)] };
      }
      return out;
    },
    [png, others, fits, fit] as const,
  );
}

/** A colour map that is colour management (gamut / range), not a different picture. */
const plausibleFit = (m: ColorFit): boolean =>
  [0, 1, 2].every((ch) => Math.abs((m[ch * 5] as number) - 1) < 0.3) &&
  [1, 2, 4, 6, 8, 9].every((i) => Math.abs(m[i] as number) < 0.3) &&
  [3, 7, 11].every((i) => Math.abs(m[i] as number) < 40);

/** No colour map to speak of: the platform treats both paths the same. */
const nearIdentity = (m: ColorFit): boolean => m.every((v, i) => Math.abs(v - (IDENTITY_FIT[i] as number)) < ([3, 7, 11].includes(i) ? 4 : 0.03));

// Resampling and YUV conversion differ slightly between paths; edges of a sharpened, zoomed test
// pattern are the worst case.
const MAX_MEAN = 6;
/**
 * Where the platform colour-manages <video> and not the frame surfaces (WebKit; Edge on Windows
 * with a hardware video path: <video> yes, 2D canvas / WebGL drawing of the frame no),
 * the colour map is fitted on the unfiltered frame and does not commute exactly with the filters:
 * the mean may drift, the share of clearly different pixels must not.
 */
const MAX_MEAN_MANAGED = 12;
const MAX_OUTLIERS = 0.03;
/** Per box: the mean limit (MAX_MEAN_MANAGED only for a path the platform colour-manages differently). */
const limits: Record<string, number> = {};
const within = (box: string, d: Diff): boolean => d.mean < (limits[box] ?? MAX_MEAN) && d.outliers < MAX_OUTLIERS;
const IDENTITY_FIT: ColorFit = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

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
  // Platform colour management: a colour map from each surface to the <video> box, fitted on the
  // unfiltered frame. Near identity (Chrome / Firefox headless, Firefox on Windows): compared as
  // is with the original limits. Otherwise (WebKit; Edge on Windows, whose <video> converts the
  // untagged SMPTE 170M picture while the frame surfaces draw it unconverted) the map must look
  // like colour management and the surface is compared after it, with the wider mean limit.
  // The in-page probe (2D canvas vs WebGL) is reported only: on Edge both draw unconverted.
  const probe = await page.evaluate(async () => (await (window.surfaces as Promise<SurfacesFixture>)).colourManaged());
  const fits: Record<string, ColorFit> = {};
  const fitted = await compareBoxes(page, boxes, {}, true);
  for (const box of boxes) {
    const d = fitted[box] as (typeof fitted)[string];
    if (!nearIdentity(d.fit)) {
      if (!plausibleFit(d.fit)) ciNotice(`surfaces: implausible colour map for ${box}, samples ${JSON.stringify(d.samples)}`);
      expect(plausibleFit(d.fit), `${box}: colour map ${JSON.stringify(d.fit.map((v) => Math.round(v * 1000) / 1000))} is colour management, not another picture`).toBe(true);
      fits[box] = d.fit;
      limits[box] = MAX_MEAN_MANAGED;
    } else {
      fits[box] = IDENTITY_FIT;
      limits[box] = MAX_MEAN;
    }
  }
  const samples: Record<string, number[][]> = {};
  const passed: Record<string, boolean> = {};
  for (const [name, t, f] of CASES) {
    await page.evaluate(async ([tt, ff]) => (await (window.surfaces as Promise<SurfacesFixture>)).apply(tt, ff), [t, f] as const);
    const rects = await page.evaluate(async () => (await (window.surfaces as Promise<SurfacesFixture>)).rects());
    // The picture rectangle (what overlays use) is the same on every surface.
    for (const r of Object.values(rects)) expect(r).toEqual(rects['video']);
    // Compositors may show a new transform / filter a few frames late (WebKit): compare the
    // settled picture, up to 2 s.
    let diffs = await compareBoxes(page, boxes, fits);
    for (let i = 0; i < 10 && !Object.entries(diffs).every(([box, d]) => within(box, d)); i++) {
      await page.waitForTimeout(200);
      diffs = await compareBoxes(page, boxes, fits);
    }
    for (const [box, diff] of Object.entries(diffs)) {
      results[`${name} ${box}`] = { mean: diff.mean, outliers: diff.outliers };
      passed[`${name} ${box}`] = within(box, diff);
      samples[`${name} ${box}`] = diff.samples;
      expect.soft(diff.mean, `${name}: ${box} vs video`).toBeLessThan(limits[box] ?? MAX_MEAN);
      expect.soft(diff.outliers, `${name}: ${box} vs video`).toBeLessThan(MAX_OUTLIERS);
    }
  }
  const ok = Object.values(passed).every(Boolean);
  if (!ok) {
    // For engines we cannot run locally (WebKit): bar colours (video box first, then the
    // surface) per case and the colour maps, on the CI run page.
    ciNotice(`surfaces diagnostics ${JSON.stringify({ fits: Object.fromEntries(Object.entries(fits).map(([k, v]) => [k, v.map((x) => Math.round(x * 1000) / 1000)])), samples })}`);
  }
  const worst = Object.values(results).reduce((w, d) => ({ mean: Math.max(w.mean, d.mean), outliers: Math.max(w.outliers, d.outliers) }), { mean: 0, outliers: 0 });
  const maps = Object.entries(fits).map(([k, v]) => `${k} ${v.map((x) => Math.round(x * 100) / 100).join(' ')}`).join('; ');
  const fittedBoxes = boxes.filter((b) => limits[b] === MAX_MEAN_MANAGED);
  const managed = `${fittedBoxes.length > 0 ? `<video> colour-managed differently from ${fittedBoxes.join(', ')}: fitted, mean limit ${MAX_MEAN_MANAGED}` : 'no colour management difference: no fit, mean limit 6'}; probe 2D ${probe.canvas2d.map(Math.round).join(',')} vs WebGL ${probe.webgl.map(Math.round).join(',')}`;
  ciNotice(`surfaces: worst mean ${worst.mean.toFixed(2)}, outliers ${(worst.outliers * 100).toFixed(2)}%; ${managed} (maps: ${maps})${ok ? '' : ` FAILED ${JSON.stringify(results)}`}`);
  info.annotations.push({ type: 'surface-diff', description: JSON.stringify(results) });
  test.info().attach('surface-diff.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
});
