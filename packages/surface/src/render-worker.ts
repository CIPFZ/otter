// Render Worker of a GPU grid (ADR-008 §6): the grid's canvas, transferred as an OffscreenCanvas,
// drawn here with the same WebGL2 renderer, so 16 views of texture uploads and draws do not share
// the main thread's frame budget. The main thread keeps layout (regions, fit, transform) and the
// frame cadence; it posts frames (transferred) and what to draw.

import { createGlRenderer, type GlRenderer, type SurfaceFrame, type ViewDraw } from './gl-renderer.js';

type Message =
  | { t: 'init'; canvas: OffscreenCanvas }
  | { t: 'frame'; id: number; frame: SurfaceFrame }
  | { t: 'forget'; id: number }
  | { t: 'render'; width: number; height: number; views: [number, ViewDraw][] }
  | { t: 'snapshot'; n: number; rect: { x: number; y: number; width: number; height: number }; type: string; quality?: number };

let renderer: GlRenderer | undefined;
let canvas: OffscreenCanvas | undefined;
let last: Extract<Message, { t: 'render' }> | undefined;

const close = (f: SurfaceFrame): void => (f as { close?: () => void }).close?.();

const draw = (m: Extract<Message, { t: 'render' }>): void => {
  if (renderer === undefined || canvas === undefined) return;
  if (canvas.width !== m.width || canvas.height !== m.height) {
    canvas.width = m.width;
    canvas.height = m.height;
  }
  renderer.render(m.width, m.height, new Map(m.views));
};

self.onmessage = (e: MessageEvent<Message>) => {
  const m = e.data;
  if (m.t === 'init') {
    canvas = m.canvas;
    renderer = createGlRenderer(canvas);
    self.postMessage({ t: 'ready', ok: renderer !== undefined });
  } else if (m.t === 'frame') {
    if (renderer === undefined) return close(m.frame);
    renderer.upload(m.id, m.frame);
    close(m.frame);
  } else if (m.t === 'forget') {
    renderer?.forget(m.id);
  } else if (m.t === 'render') {
    last = m;
    draw(m);
    // Backpressure: the grid sends the next render (and its frames) after this.
    self.postMessage({ t: 'rendered' });
  } else if (m.t === 'snapshot') {
    void (async () => {
      try {
        if (canvas === undefined || last === undefined) throw new Error('nothing drawn yet');
        // The drawing buffer is only defined right after drawing: draw, then copy the region.
        draw(last);
        const r = m.rect;
        const bitmap = await createImageBitmap(canvas, Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)));
        const out = new OffscreenCanvas(bitmap.width, bitmap.height);
        (out.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(bitmap, 0, 0);
        bitmap.close();
        const blob = await out.convertToBlob({ type: m.type, ...(m.quality === undefined ? {} : { quality: m.quality }) });
        self.postMessage({ t: 'snapshot', n: m.n, blob });
      } catch (err) {
        self.postMessage({ t: 'snapshot', n: m.n, error: String(err) });
      }
    })();
  }
};
