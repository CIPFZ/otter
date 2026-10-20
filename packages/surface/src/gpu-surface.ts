// GPUSurface and CanvasSurface (SPEC §12, ADR-008 §6): frame sinks for the WebCodecs backend.
// A GPU grid is one WebGL2 context on one canvas with any number of views (multi-view walls share
// it, so the browser's ~16 context limit is never hit silently); createGPUSurface is a grid with
// one full-canvas view. CanvasSurface is the 2D fallback where WebGL2 is unavailable. Both take
// the latest frame per view and draw once per animation frame, so a hidden page uploads and
// renders nothing (background mode). Fit, transform and filters follow VideoSurface exactly.

import { createError, createEventBus, type Unsubscribe } from '@otter-player/core';
import { cssOnly, NEUTRAL_FILTERS, shorthandCss } from './filter-css.js';
import { createGlRenderer, frameSize, isI420, type GlRenderer, type I420Frame, type PixelRect, type SurfaceFrame, type ViewDraw } from './gl-renderer.js';
import type { GPUSurfaceOptions, SnapshotOptions, Surface, SurfaceColorInfo, SurfaceFilters, SurfaceFit, SurfaceTransform } from './surface.js';
import type { SvgFilter } from './svg-filter.js';
import { computeContentRect, IDENTITY_TRANSFORM, type PictureRect } from './video-surface.js';

/** A Surface that draws decoded frames. `draw` takes ownership of VideoFrames (closes them). */
export interface FrameSurface extends Surface {
  readonly kind: 'gpu' | 'canvas2d';
  readonly element: HTMLCanvasElement;
  draw(frame: SurfaceFrame): void;
  /** Back to black (no picture). */
  clear(): void;
}

/** Region of the canvas, as fractions of its box. */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const FULL_REGION: Region = { x: 0, y: 0, width: 1, height: 1 };

export interface GPUView extends FrameSurface {
  readonly kind: 'gpu';
  readonly region: Region;
  setRegion(region: Region): void;
}

export interface GPUGrid {
  readonly element: HTMLCanvasElement;
  readonly api: 'webgl2';
  readonly views: readonly GPUView[];
  createView(region?: Region): GPUView;
  destroy(): void;
}

const SDR_SRGB: SurfaceColorInfo = { range: 'sdr', gamut: 'srgb' };

let liveContexts = 0;
/** WebGL contexts Otter holds right now (GPU grids and surfaces). */
export const gpuContextCount = (): number => liveContexts;

const toDomRect = (r: PictureRect): DOMRectReadOnly =>
  typeof DOMRectReadOnly === 'function'
    ? new DOMRectReadOnly(r.x, r.y, r.width, r.height)
    : { ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height, toJSON: () => r };

const closeFrame = (f: SurfaceFrame | undefined): void => {
  if (f !== undefined && typeof (f as VideoFrame).close === 'function' && !isI420(f)) (f as VideoFrame).close();
};

const schedule = (cb: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
  else setTimeout(cb, 16);
};

/** Picture state shared by both sinks: fit, transform, filters, the pending frame, the rect. */
function createViewState(canvas: HTMLCanvasElement, regionOf: () => Region) {
  const bus = createEventBus<{ rect: DOMRectReadOnly }>();
  let fit: SurfaceFit = 'contain';
  let transform: SurfaceTransform = IDENTITY_TRANSFORM;
  let filters: SurfaceFilters = NEUTRAL_FILTERS;
  let picture: { width: number; height: number } = { width: 0, height: 0 };
  let rect: PictureRect = { x: 0, y: 0, width: 0, height: 0 };
  /** Region in CSS pixels of the canvas box. */
  const regionCss = (): PictureRect => {
    const r = regionOf();
    return { x: r.x * canvas.clientWidth, y: r.y * canvas.clientHeight, width: r.width * canvas.clientWidth, height: r.height * canvas.clientHeight };
  };
  const update = (): void => {
    const box = regionCss();
    const c = computeContentRect({ width: box.width, height: box.height }, picture, fit, transform);
    const next = { x: box.x + c.x, y: box.y + c.y, width: c.width, height: c.height };
    if (next.x !== rect.x || next.y !== rect.y || next.width !== rect.width || next.height !== rect.height) {
      rect = next;
      bus.emit('rect', toDomRect(rect));
    }
  };
  return {
    bus,
    get fit() {
      return fit;
    },
    set fit(f: SurfaceFit) {
      fit = f;
      update();
    },
    get transform() {
      return transform;
    },
    set transform(t: SurfaceTransform) {
      transform = t;
      update();
    },
    get filters() {
      return filters;
    },
    set filters(f: SurfaceFilters) {
      filters = f;
    },
    get rect() {
      return rect;
    },
    regionCss,
    setPicture(size: { width: number; height: number }) {
      if (size.width === picture.width && size.height === picture.height) return;
      picture = size;
      update();
    },
    update,
  };
}

type ViewState = ReturnType<typeof createViewState>;

/** Device-pixel ratio of the canvas' window. */
const dpr = (canvas: HTMLCanvasElement): number => canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;

/** Keeps the canvas backing store at its CSS size times the device-pixel ratio. */
function trackSize(canvas: HTMLCanvasElement, changed: () => void): () => void {
  const fit = (): void => {
    const ratio = dpr(canvas);
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    changed();
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : undefined;
  observer?.observe(canvas);
  fit();
  return () => observer?.disconnect();
}

const devicePx = (canvas: HTMLCanvasElement, r: PictureRect): PixelRect => {
  const sx = canvas.width / Math.max(1, canvas.clientWidth);
  const sy = canvas.height / Math.max(1, canvas.clientHeight);
  return { x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy };
};

function snapshotRegion(canvas: HTMLCanvasElement, region: PictureRect, render: () => void, opts: SnapshotOptions): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const fail = (details: string, cause?: unknown): void =>
      reject(createError({ type: 'other', details, fatal: false, recoverable: false, message: details, ...(cause === undefined ? {} : { cause }) }));
    const px = devicePx(canvas, region);
    const out = canvas.ownerDocument.createElement('canvas');
    out.width = Math.max(1, Math.round(px.width));
    out.height = Math.max(1, Math.round(px.height));
    const ctx = out.getContext('2d');
    if (ctx === null) return fail('snapshotUnavailable');
    try {
      // The WebGL drawing buffer is only defined right after drawing: render, then copy.
      render();
      ctx.drawImage(canvas, px.x, px.y, px.width, px.height, 0, 0, out.width, out.height);
    } catch (err) {
      return fail('snapshotFailed', err);
    }
    out.toBlob((blob) => (blob === null ? fail('snapshotFailed') : resolve(blob)), `image/${opts.type ?? 'png'}`, opts.quality);
  });
}

export interface GPUGridOptions extends GPUSurfaceOptions {
  /** Contexts Otter may hold before refusing a new grid (browsers drop the oldest past ~16). */
  readonly maxContexts?: number;
}

/** One WebGL2 context on `canvas`, drawing any number of views. Throws when WebGL2 is unavailable. */
export function createGPUGrid(canvas: HTMLCanvasElement, options: GPUGridOptions = {}): GPUGrid {
  const max = options.maxContexts ?? 16;
  if (liveContexts >= max) {
    throw createError({ type: 'other', details: 'gpuContextLimit', fatal: false, recoverable: true, message: `${liveContexts} WebGL contexts in use (limit ${max}); share a GPU grid between views` });
  }
  const renderer: GlRenderer | undefined = createGlRenderer(canvas);
  if (renderer === undefined) throw createError({ type: 'other', details: 'webgl2Unavailable', fatal: false, recoverable: true, message: 'no WebGL2 context on this canvas' });
  liveContexts++;
  let ids = 0;
  let scheduled = false;
  let destroyed = false;
  type Internal = GPUView & { readonly id: number; state: ViewState; pending: SurfaceFrame | undefined; destroyed: boolean };
  const views: Internal[] = [];
  const destroyView = (view: Internal): void => {
    if (view.destroyed) return;
    view.destroyed = true;
    closeFrame(view.pending);
    view.pending = undefined;
    renderer.forget(view.id);
    views.splice(views.indexOf(view), 1);
    view.state.bus.clear();
    request();
  };

  const render = (): void => {
    if (destroyed) return;
    const draws = new Map<number, ViewDraw>();
    for (const v of views) {
      if (v.pending !== undefined) {
        renderer.upload(v.id, v.pending);
        closeFrame(v.pending);
        v.pending = undefined;
      }
      draws.set(v.id, { region: devicePx(canvas, v.state.regionCss()), content: devicePx(canvas, v.state.rect), transform: v.state.transform, filters: v.state.filters });
    }
    renderer.render(canvas.width, canvas.height, draws);
  };
  const request = (): void => {
    if (scheduled || destroyed) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      render();
    });
  };
  const stopSize = trackSize(canvas, () => {
    for (const v of views) v.state.update();
    request();
  });

  const grid: GPUGrid = {
    element: canvas,
    api: 'webgl2',
    get views() {
      return views.filter((v) => !v.destroyed);
    },
    createView(initial = FULL_REGION) {
      let region = initial;
      const id = ++ids;
      const state = createViewState(canvas, () => region);
      const view: Internal = {
        kind: 'gpu' as const,
        element: canvas,
        id,
        state,
        pending: undefined as SurfaceFrame | undefined,
        destroyed: false,
        colorInfo: SDR_SRGB,
        get region() {
          return region;
        },
        get contentRect() {
          return toDomRect(state.rect);
        },
        setRegion(r: Region) {
          region = r;
          state.update();
          request();
        },
        setFit(f: SurfaceFit) {
          state.fit = f;
          request();
        },
        setTransform(t: SurfaceTransform) {
          state.transform = t;
          request();
        },
        setFilters(f: Partial<SurfaceFilters>) {
          state.filters = { ...state.filters, ...f };
          request();
        },
        draw(frame: SurfaceFrame) {
          if (view.destroyed) return closeFrame(frame);
          closeFrame(view.pending);
          view.pending = frame;
          state.setPicture(frameSize(frame));
          request();
        },
        clear() {
          closeFrame(view.pending);
          view.pending = undefined;
          renderer.forget(id);
          state.setPicture({ width: 0, height: 0 });
          request();
        },
        snapshot: (opts: SnapshotOptions = {}) => snapshotRegion(canvas, state.rect, render, opts),
        onContentRectChange: (h: (r: DOMRectReadOnly) => void): Unsubscribe => state.bus.on('rect', (r) => h(r)),
        destroy() {
          destroyView(view);
        },
      };
      views.push(view);
      request();
      return view;
    },
    destroy() {
      if (destroyed) return;
      for (const v of [...views]) destroyView(v);
      destroyed = true;
      stopSize();
      renderer.destroy();
      liveContexts--;
    },
  };
  return grid;
}

/** A GPU surface on its own canvas: a grid with one full-canvas view. */
export function createGPUSurface(canvas: HTMLCanvasElement, options: GPUGridOptions = {}): GPUView {
  const grid = createGPUGrid(canvas, options);
  const view = grid.createView();
  // Destroying the only view releases the whole context.
  (view as { destroy: () => void }).destroy = () => grid.destroy();
  return view;
}

/** Canvas 2D sink: the WebCodecs fallback where WebGL2 is unavailable (e.g. headless Firefox). */
export function createCanvasSurface(canvas: HTMLCanvasElement): FrameSurface {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw createError({ type: 'other', details: 'canvas2dUnavailable', fatal: false, recoverable: false, message: 'no 2D context on this canvas' });
  const state = createViewState(canvas, () => FULL_REGION);
  // Temperature / sharpen need the SVG filter chunk; loaded on first use.
  let svg: SvgFilter | undefined;
  let svgLoading = false;
  let pending: SurfaceFrame | undefined;
  let last: CanvasImageSource | undefined;
  let scheduled = false;
  let destroyed = false;

  const source = (f: SurfaceFrame): CanvasImageSource => {
    if (!isI420(f)) return f as CanvasImageSource;
    // 2D canvases cannot take planes: wrap them in a VideoFrame (copied once).
    const i = f as I420Frame;
    return new VideoFrame(i.data, { format: 'I420', codedWidth: i.width, codedHeight: i.height, timestamp: i.timestamp });
  };
  const render = (): void => {
    if (destroyed) return;
    const f = state.filters;
    if (!cssOnly(f) && svg === undefined) {
      // Draw nothing until the filter is there (no frame with the wrong colours).
      if (!svgLoading) {
        svgLoading = true;
        void import('./svg-filter.js').then((m) => {
          svg = m.createSvgFilter(canvas);
          if (destroyed) svg.destroy();
          else request();
        });
      }
      return;
    }
    if (pending !== undefined) {
      if (last !== undefined && typeof (last as VideoFrame).close === 'function') (last as VideoFrame).close();
      last = source(pending);
      // A VideoFrame we were given is kept as `last` (closed on replace); I420 was wrapped above.
      pending = undefined;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (last === undefined) return;
    const c = devicePx(canvas, state.rect);
    const t = state.transform;
    const turned = t.rotate === 90 || t.rotate === 270;
    const [w, h] = turned ? [c.height, c.width] : [c.width, c.height];
    ctx.filter = (svg === undefined ? shorthandCss(f) : svg.css(f)) || 'none';
    ctx.translate(c.x + c.width / 2, c.y + c.height / 2);
    ctx.rotate((t.rotate * Math.PI) / 180);
    if (t.mirror) ctx.scale(-1, 1);
    ctx.drawImage(last, -w / 2, -h / 2, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };
  const request = (): void => {
    if (scheduled || destroyed) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      render();
    });
  };
  const stopSize = trackSize(canvas, () => {
    state.update();
    request();
  });

  return {
    kind: 'canvas2d',
    element: canvas,
    colorInfo: SDR_SRGB,
    get contentRect() {
      return toDomRect(state.rect);
    },
    setFit(f) {
      state.fit = f;
      request();
    },
    setTransform(t) {
      state.transform = t;
      request();
    },
    setFilters(f) {
      state.filters = { ...state.filters, ...f };
      request();
    },
    draw(frame) {
      if (destroyed) return closeFrame(frame);
      closeFrame(pending);
      pending = frame;
      state.setPicture(frameSize(frame));
      request();
    },
    clear() {
      closeFrame(pending);
      pending = undefined;
      if (last !== undefined && typeof (last as VideoFrame).close === 'function') (last as VideoFrame).close();
      last = undefined;
      state.setPicture({ width: 0, height: 0 });
      request();
    },
    snapshot: (opts = {}) => snapshotRegion(canvas, state.rect, render, opts),
    onContentRectChange: (h) => state.bus.on('rect', (r) => h(r)),
    destroy() {
      destroyed = true;
      closeFrame(pending);
      if (last !== undefined && typeof (last as VideoFrame).close === 'function') (last as VideoFrame).close();
      stopSize();
      svg?.destroy();
      state.bus.clear();
    },
  };
}

/** GPUSurface when WebGL2 is there, CanvasSurface otherwise. */
export function createFrameSurface(canvas: HTMLCanvasElement, options: GPUGridOptions = {}): FrameSurface {
  try {
    return createGPUSurface(canvas, options);
  } catch (err) {
    if ((err as { details?: string } | null)?.details !== 'webgl2Unavailable') throw err;
    return createCanvasSurface(canvas);
  }
}
