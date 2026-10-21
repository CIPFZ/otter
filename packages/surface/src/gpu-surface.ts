// GPUSurface and CanvasSurface (SPEC §12, ADR-008 §6): frame sinks for the WebCodecs backend.
// A GPU grid is one WebGL2 context on one canvas with any number of views (multi-view walls share
// it, so the browser's ~16 context limit is never hit silently); createGPUSurface is a grid with
// one full-canvas view. CanvasSurface is the 2D fallback where WebGL2 is unavailable. Both take
// the latest frame per view and draw once per animation frame, so a hidden page uploads and
// renders nothing (background mode). Fit, transform and filters follow VideoSurface exactly.

import { createError, createEventBus, type Unsubscribe } from '@otter-player/core';
import { NEUTRAL_FILTERS } from './filter-css.js';
import { createGlRenderer, frameSize, isI420, type GlRenderer, type I420Frame, type PixelRect, type SurfaceFrame, type ViewDraw } from './gl-renderer.js';
import type { GPUSurfaceOptions, SnapshotOptions, Surface, SurfaceColorInfo, SurfaceFilters, SurfaceFit, SurfaceTransform } from './surface.js';
import { computeContentRect, createElementFilter, IDENTITY_TRANSFORM, type PictureRect } from './video-surface.js';

/** A Surface that draws decoded frames. `draw` takes ownership of VideoFrames (closes them). */
export interface FrameSurface extends Surface {
  readonly kind: 'gpu' | 'canvas2d';
  readonly element: HTMLCanvasElement;
  /** The picture as drawn (zoom and pan applied); `contentRect` stays the fitted picture. */
  readonly drawnRect: DOMRectReadOnly;
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
  /** Frames handed to draw() that a newer one replaced before the renderer took them. */
  readonly framesReplaced: number;
  setRegion(region: Region): void;
}

export interface GPUGrid {
  readonly element: HTMLCanvasElement;
  readonly api: 'webgl2';
  /** Where uploads and draws run. */
  readonly renderer: 'main' | 'worker';
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
  /** Fitted rect (zoom 1): what overlays align to and contentRect reports. */
  let rect: PictureRect = { x: 0, y: 0, width: 0, height: 0 };
  /** The picture as drawn (zoom / pan / viewport applied). */
  let drawn: PictureRect = { x: 0, y: 0, width: 0, height: 0 };
  /** Region in CSS pixels of the canvas box. */
  const regionCss = (): PictureRect => {
    const r = regionOf();
    return { x: r.x * canvas.clientWidth, y: r.y * canvas.clientHeight, width: r.width * canvas.clientWidth, height: r.height * canvas.clientHeight };
  };
  const update = (): void => {
    const box = regionCss();
    const size = { width: box.width, height: box.height };
    // Overlays never zoom with the picture (text stays its size); the drawn rect does.
    const f = computeContentRect(size, picture, fit, { rotate: transform.rotate, mirror: transform.mirror, zoom: 1, pan: [0, 0] });
    const d = computeContentRect(size, picture, fit, transform);
    drawn = { x: box.x + d.x, y: box.y + d.y, width: d.width, height: d.height };
    const c = f;
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
    get drawn() {
      return drawn;
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

/** Backing-store size of a canvas (the canvas itself, or the one a render Worker holds). */
interface PixelSize {
  width: number;
  height: number;
}

/** Keeps the backing store at the canvas' CSS size times the device-pixel ratio. */
function trackSize(canvas: HTMLCanvasElement, changed: () => void, size: PixelSize = canvas): () => void {
  const fit = (): void => {
    const ratio = dpr(canvas);
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (size.width !== w || size.height !== h) {
      size.width = w;
      size.height = h;
    }
    changed();
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : undefined;
  observer?.observe(canvas);
  fit();
  return () => observer?.disconnect();
}

const devicePx = (canvas: HTMLCanvasElement, r: PictureRect, size: PixelSize = canvas): PixelRect => {
  const sx = size.width / Math.max(1, canvas.clientWidth);
  const sy = size.height / Math.max(1, canvas.clientHeight);
  return { x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy };
};

function snapshotPixels(canvas: HTMLCanvasElement, px: PixelRect, render: () => void, opts: SnapshotOptions): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const out = canvas.ownerDocument.createElement('canvas');
    out.width = Math.max(1, Math.round(px.width));
    out.height = Math.max(1, Math.round(px.height));
    const ctx = out.getContext('2d');
    if (ctx === null) return reject(snapshotError('snapshotUnavailable'));
    try {
      // The WebGL drawing buffer is only defined right after drawing: render, then copy.
      render();
      ctx.drawImage(canvas, px.x, px.y, px.width, px.height, 0, 0, out.width, out.height);
    } catch (err) {
      return reject(snapshotError('snapshotFailed', err));
    }
    out.toBlob((blob) => (blob === null ? reject(snapshotError('snapshotFailed')) : resolve(blob)), `image/${opts.type ?? 'png'}`, opts.quality);
  });
}

const snapshotRegion = (canvas: HTMLCanvasElement, region: PictureRect, render: () => void, opts: SnapshotOptions): Promise<Blob> =>
  snapshotPixels(canvas, devicePx(canvas, region), render, opts);

export interface GPUGridOptions extends GPUSurfaceOptions {
  /** Contexts Otter may hold before refusing a new grid (browsers drop the oldest past ~16). */
  readonly maxContexts?: number;
  /**
   * Render in a Worker (OffscreenCanvas) where WebGL2 works there: uploads and draws of many views
   * stay off the main thread. Layout, contentRect and the frame cadence stay on the main thread.
   */
  readonly worker?: boolean;
}

/** What a grid draws with: the WebGL2 renderer here, or the one in a render Worker. */
interface GridRenderer {
  readonly where: 'main' | 'worker';
  /** A render is still being drawn elsewhere (Worker): wait for `onIdle` before the next. */
  readonly busy: boolean;
  onIdle(cb: () => void): void;
  /** Takes ownership of `frame`. */
  upload(id: number, frame: SurfaceFrame): void;
  forget(id: number): void;
  render(width: number, height: number, views: ReadonlyMap<number, ViewDraw>): void;
  snapshot(region: PixelRect, opts: SnapshotOptions): Promise<Blob>;
  destroy(): void;
}

/** WebGL2 in an OffscreenCanvas, which is where a render Worker would draw. */
export const workerRenderingSupported = (): boolean => {
  if (typeof OffscreenCanvas !== 'function' || typeof Worker !== 'function') return false;
  if (typeof HTMLCanvasElement !== 'function' || !('transferControlToOffscreen' in HTMLCanvasElement.prototype)) return false;
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
};

const snapshotError = (details: string, cause?: unknown): Error =>
  createError({ type: 'other', details, fatal: false, recoverable: false, message: details, ...(cause === undefined ? {} : { cause }) });

function localRenderer(canvas: HTMLCanvasElement, renderer: GlRenderer, last: { draw: () => void }): GridRenderer {
  return {
    where: 'main',
    busy: false,
    onIdle: () => undefined,
    upload(id, frame) {
      renderer.upload(id, frame);
      closeFrame(frame);
    },
    forget: (id) => renderer.forget(id),
    render: (w, h, views) => renderer.render(w, h, views),
    snapshot: (region, opts) => snapshotPixels(canvas, region, last.draw, opts),
    destroy: () => renderer.destroy(),
  };
}

function workerRenderer(canvas: HTMLCanvasElement): GridRenderer {
  const worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage({ t: 'init', canvas: offscreen }, [offscreen]);
  const snapshots = new Map<number, { resolve: (b: Blob) => void; reject: (e: unknown) => void }>();
  let n = 0;
  /** Renders posted and not yet acknowledged; two may be in flight (absorbs latency spikes). */
  let inFlight = 0;
  const DEPTH = 3;
  let idle: (() => void) | undefined;
  worker.onmessage = (e: MessageEvent<{ t: string; n?: number; blob?: Blob; error?: string }>) => {
    const m = e.data;
    if (m.t === 'rendered') {
      inFlight = Math.max(0, inFlight - 1);
      idle?.();
      return;
    }
    if (m.t !== 'snapshot' || m.n === undefined) return;
    const p = snapshots.get(m.n);
    snapshots.delete(m.n);
    if (m.blob !== undefined) p?.resolve(m.blob);
    else p?.reject(snapshotError('snapshotFailed', m.error));
  };
  const transferOf = (f: SurfaceFrame): Transferable[] => {
    if (isI420(f)) return [f.data.buffer as ArrayBuffer];
    if (typeof VideoFrame === 'function' && f instanceof VideoFrame) return [f];
    if (typeof ImageBitmap === 'function' && f instanceof ImageBitmap) return [f];
    return [];
  };
  return {
    where: 'worker',
    get busy() {
      return inFlight >= DEPTH;
    },
    onIdle(cb) {
      idle = cb;
    },
    upload(id, frame) {
      // Elements cannot cross to a Worker: those go as a VideoFrame / bitmap copy.
      const sendable = typeof HTMLVideoElement === 'function' && frame instanceof HTMLVideoElement ? new VideoFrame(frame) : frame;
      worker.postMessage({ t: 'frame', id, frame: sendable }, transferOf(sendable));
    },
    forget: (id) => worker.postMessage({ t: 'forget', id }),
    render(width, height, views) {
      inFlight++;
      worker.postMessage({ t: 'render', width, height, views: [...views] });
    },
    snapshot: (region, opts) =>
      new Promise<Blob>((resolve, reject) => {
        const k = ++n;
        snapshots.set(k, { resolve, reject });
        worker.postMessage({ t: 'snapshot', n: k, rect: region, type: `image/${opts.type ?? 'png'}`, ...(opts.quality === undefined ? {} : { quality: opts.quality }) });
      }),
    destroy() {
      for (const p of snapshots.values()) p.reject(snapshotError('snapshotFailed', 'grid destroyed'));
      worker.terminate();
    },
  };
}

/** One WebGL2 context on `canvas`, drawing any number of views. Throws when WebGL2 is unavailable. */
export function createGPUGrid(canvas: HTMLCanvasElement, options: GPUGridOptions = {}): GPUGrid {
  const max = options.maxContexts ?? 16;
  if (liveContexts >= max) {
    throw createError({ type: 'other', details: 'gpuContextLimit', fatal: false, recoverable: true, message: `${liveContexts} WebGL contexts in use (limit ${max}); share a GPU grid between views` });
  }
  const size: PixelSize = { width: Math.max(1, canvas.width), height: Math.max(1, canvas.height) };
  const drawNow = { draw: (): void => undefined };
  let renderer: GridRenderer;
  if (options.worker === true && workerRenderingSupported()) {
    renderer = workerRenderer(canvas);
  } else {
    const gl: GlRenderer | undefined = createGlRenderer(canvas);
    if (gl === undefined) throw createError({ type: 'other', details: 'webgl2Unavailable', fatal: false, recoverable: true, message: 'no WebGL2 context on this canvas' });
    renderer = localRenderer(canvas, gl, drawNow);
  }
  // The local renderer draws into the canvas itself: its size is the canvas' size.
  const target: PixelSize = renderer.where === 'main' ? canvas : size;
  liveContexts++;
  let ids = 0;
  let scheduled = false;
  let destroyed = false;
  type Internal = GPUView & { readonly id: number; state: ViewState; pending: SurfaceFrame | undefined; destroyed: boolean; replaced: number };
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
      // A hidden view (zero region: another view expanded) keeps only its latest frame, unuploaded.
      const visible = v.region.width > 0 && v.region.height > 0;
      if (v.pending !== undefined && visible) {
        renderer.upload(v.id, v.pending);
        v.pending = undefined;
      }
      draws.set(v.id, { region: devicePx(canvas, v.state.regionCss(), target), content: devicePx(canvas, v.state.drawn, target), transform: v.state.transform, filters: v.state.filters });
    }
    renderer.render(target.width, target.height, draws);
  };
  drawNow.draw = render;
  const request = (): void => {
    if (scheduled || destroyed) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      // A render Worker still drawing the last one: newer frames wait (latest per view).
      if (renderer.busy) {
        waiting = true;
        return;
      }
      render();
    });
  };
  let waiting = false;
  renderer.onIdle(() => {
    if (!waiting) return;
    waiting = false;
    // Straight away, not on the next animation frame: waiting for both would halve the rate.
    render();
  });
  const stopSize = trackSize(
    canvas,
    () => {
      for (const v of views) v.state.update();
      request();
    },
    target,
  );

  const grid: GPUGrid = {
    element: canvas,
    api: 'webgl2',
    renderer: renderer.where,
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
        replaced: 0,
        get framesReplaced() {
          return view.replaced;
        },
        colorInfo: SDR_SRGB,
        get region() {
          return region;
        },
        get contentRect() {
          return toDomRect(state.rect);
        },
        get drawnRect() {
          return toDomRect(state.drawn);
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
          if (view.pending !== undefined) {
            // Never shown: a newer frame came before the renderer took this one.
            view.replaced++;
            closeFrame(view.pending);
          }
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
        snapshot: (opts: SnapshotOptions = {}) => renderer.snapshot(devicePx(canvas, state.drawn, target), opts),
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

/**
 * Canvas 2D sink: the WebCodecs fallback where WebGL2 is unavailable (e.g. headless Firefox).
 * One picture per canvas, so filters go on the canvas element itself, exactly like VideoSurface
 * (WebKit ignores url() filters in ctx.filter); the letterbox stays transparent for that.
 */
export function createCanvasSurface(canvas: HTMLCanvasElement): FrameSurface {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw createError({ type: 'other', details: 'canvas2dUnavailable', fatal: false, recoverable: false, message: 'no 2D context on this canvas' });
  const state = createViewState(canvas, () => FULL_REGION);
  const filter = createElementFilter(canvas);
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
    if (pending !== undefined) {
      if (last !== undefined && typeof (last as VideoFrame).close === 'function') (last as VideoFrame).close();
      last = source(pending);
      // A VideoFrame we were given is kept as `last` (closed on replace); I420 was wrapped above.
      pending = undefined;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (last === undefined) return;
    const c = devicePx(canvas, state.drawn);
    const t = state.transform;
    const turned = t.rotate === 90 || t.rotate === 270;
    const [w, h] = turned ? [c.height, c.width] : [c.width, c.height];
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
    get drawnRect() {
      return toDomRect(state.drawn);
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
      filter.set(state.filters);
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
    snapshot: (opts = {}) => snapshotRegion(canvas, state.drawn, render, opts),
    onContentRectChange: (h) => state.bus.on('rect', (r) => h(r)),
    destroy() {
      destroyed = true;
      closeFrame(pending);
      if (last !== undefined && typeof (last as VideoFrame).close === 'function') (last as VideoFrame).close();
      stopSize();
      filter.destroy();
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
