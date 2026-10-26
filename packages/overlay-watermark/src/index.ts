// Watermark (SPEC §13.3, ADR-012 §7): two modes over the picture.
// - `static`: a logo or text fixed in a corner (DOM), e.g. the channel mark.
// - `moving`: text (a viewer id) drawn on a canvas at a random place on the picture, moved every
//   few seconds, against screen recording; drawn on a canvas, so no one CSS rule hides it, and
//   put back (element, style) if a page script or extension removes it.
// The overlay sits in the player container, so it follows fullscreen (native and pseudo) and
// Document PiP. Video PiP shows only a <video>: `createPipComposite` draws the picture and the
// watermark into a canvas whose stream goes to PiP instead (`@otter-player/presentation/canvas-pip`).

import type { Overlay, OverlayHost } from '@otter-player/surface';

export type WatermarkCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface WatermarkOptions {
  readonly mode: 'static' | 'moving';
  /** The text (moving: e.g. the viewer id). */
  readonly text?: string;
  /** Static: an image URL instead of text. */
  readonly image?: string;
  /** Static: where; default top-right. */
  readonly corner?: WatermarkCorner;
  /** Default 0.6 static, 0.25 moving. */
  readonly opacity?: number;
  /** Moving: seconds at one place; default 8. */
  readonly interval?: number;
  /** Text px for a 720-line picture (scaled with the picture); default 20. */
  readonly fontSize?: number;
  /** CSS colour of the text; default white. */
  readonly color?: string;
  /** Injectable for tests: 0..1. */
  readonly random?: () => number;
}

/** The watermark's place on the picture, as fractions of it (x, y of the top-left; w, h). */
export interface WatermarkPlace {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Watermark {
  readonly overlay: Overlay;
  /** Where it is now, as fractions of the picture (for the PiP composite and tests). */
  place(): WatermarkPlace;
  /** Draws the watermark into a 2D context over a picture of `width` x `height` px. */
  paint(ctx: CanvasRenderingContext2D, width: number, height: number): void;
}

const MARGIN = 0.02;

export function createWatermark(options: WatermarkOptions): Watermark {
  const random = options.random ?? Math.random;
  const opacity = options.opacity ?? (options.mode === 'static' ? 0.6 : 0.25);
  const color = options.color ?? '#fff';
  let host: OverlayHost | undefined;
  let el: HTMLElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let observer: MutationObserver | undefined;
  let image: HTMLImageElement | undefined;
  let offs: (() => void)[] = [];
  /** Moving: top-left as fractions of the free room; the next move at (performance.now() ms). */
  let spot = { x: random(), y: random() };
  let nextMove = 0;
  let px = 20;

  const fontPx = (h: number): number => Math.max(10, Math.round(((options.fontSize ?? 20) * h) / 720));
  const font = (size: number): string => `600 ${size}px system-ui, sans-serif`;
  /** Text size measured with a 2D context (width px), at `size`. */
  const measure = (ctx: CanvasRenderingContext2D, size: number): { w: number; h: number } => {
    ctx.font = font(size);
    return { w: Math.ceil(ctx.measureText(options.text ?? '').width), h: Math.ceil(size * 1.3) };
  };

  const placeFor = (w: number, h: number, box: { w: number; h: number }): WatermarkPlace => {
    const fw = Math.min(1, box.w / Math.max(1, w));
    const fh = Math.min(1, box.h / Math.max(1, h));
    if (options.mode === 'moving') return { x: MARGIN + spot.x * Math.max(0, 1 - 2 * MARGIN - fw), y: MARGIN + spot.y * Math.max(0, 1 - 2 * MARGIN - fh), w: fw, h: fh };
    const corner = options.corner ?? 'top-right';
    return {
      x: corner.endsWith('left') ? MARGIN : 1 - MARGIN - fw,
      y: corner.startsWith('top') ? MARGIN : 1 - MARGIN - fh,
      w: fw,
      h: fh,
    };
  };

  let measured = { w: 0, h: 0 };
  /** Where the watermark is on the picture now (fractions). */
  const where = (): WatermarkPlace => {
    const r = host?.contentRect;
    if (r === undefined || el === undefined) return { x: MARGIN, y: MARGIN, w: 0, h: 0 };
    const box = options.mode === 'static' ? { w: el.offsetWidth, h: el.offsetHeight } : measured;
    return placeFor(r.width, r.height, box);
  };

  const layout = (): void => {
    if (host === undefined || el === undefined) return;
    const r = host.contentRect;
    px = fontPx(r.height);
    if (options.mode === 'static') {
      // Image or text box, positioned in the picture's corner.
      const w = image !== undefined ? Math.round((image.naturalWidth * px * 2) / Math.max(1, image.naturalHeight)) : undefined;
      if (image !== undefined) Object.assign(image.style, { height: `${px * 2}px`, width: w === undefined ? '' : `${w}px` });
      else el.style.font = font(px);
      const box = { w: el.offsetWidth, h: el.offsetHeight };
      const p = placeFor(r.width, r.height, box);
      Object.assign(el.style, { left: `${r.x + p.x * r.width}px`, top: `${r.y + p.y * r.height}px` });
      return;
    }
    const ctx = canvas?.getContext('2d');
    if (ctx == null || canvas === undefined) return;
    measured = measure(ctx, px);
    const p = placeFor(r.width, r.height, measured);
    const dpr = host.root.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    canvas.width = Math.max(1, Math.round(measured.w * dpr));
    canvas.height = Math.max(1, Math.round(measured.h * dpr));
    Object.assign(canvas.style, { left: `${r.x + p.x * r.width}px`, top: `${r.y + p.y * r.height}px`, width: `${measured.w}px`, height: `${measured.h}px` });
    const c = canvas.getContext('2d') as CanvasRenderingContext2D;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, measured.w, measured.h);
    drawText(c, 0, 0, px);
  };
  const drawText = (c: CanvasRenderingContext2D, x: number, y: number, size: number): void => {
    c.font = font(size);
    c.textBaseline = 'top';
    c.globalAlpha = opacity;
    c.fillStyle = color;
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = Math.max(1, size / 8);
    c.fillText(options.text ?? '', x, y + size * 0.15);
    c.shadowBlur = 0;
    c.globalAlpha = 1;
  };

  /** Puts the element back if it was removed or restyled to hide it (moving mode). */
  const guard = (): void => {
    if (host === undefined || el === undefined) return;
    if (el.parentNode !== host.root) host.root.append(el);
    const s = el.style;
    if (s.display !== '' || s.visibility !== '' || s.opacity !== String(options.mode === 'static' ? opacity : 1) || el.hidden) {
      s.display = '';
      s.visibility = '';
      s.opacity = String(options.mode === 'static' ? opacity : 1);
      el.hidden = false;
    }
  };

  const overlay: Overlay = {
    id: 'watermark',
    // Above captions and danmaku: never covered by them.
    zIndex: 400,
    mount(h) {
      host = h;
      const doc = h.root.ownerDocument;
      if (options.mode === 'static') {
        el = doc.createElement('div');
        if (options.image !== undefined) {
          image = doc.createElement('img');
          image.alt = '';
          image.src = options.image;
          image.addEventListener('load', layout);
          el.append(image);
        } else {
          el.textContent = options.text ?? '';
          Object.assign(el.style, { color, textShadow: '0 1px 2px rgba(0,0,0,0.6)', whiteSpace: 'nowrap' });
        }
      } else {
        canvas = doc.createElement('canvas');
        el = canvas;
      }
      el.dataset['otterWatermark'] = options.mode;
      el.setAttribute('aria-hidden', 'true');
      Object.assign(el.style, { position: 'absolute', pointerEvents: 'none', userSelect: 'none', opacity: String(options.mode === 'static' ? opacity : 1) });
      h.root.append(el);
      offs = [h.onContentRectChange(layout)];
      if (options.mode === 'moving' && typeof MutationObserver === 'function') {
        observer = new MutationObserver(guard);
        observer.observe(h.root, { childList: true });
        observer.observe(el, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
      }
      layout();
    },
    tick(now) {
      if (options.mode !== 'moving' || host === undefined) return;
      if (now < nextMove) return;
      nextMove = now + (options.interval ?? 8) * 1000;
      spot = { x: random(), y: random() };
      guard();
      layout();
    },
    destroy() {
      for (const off of offs) off();
      offs = [];
      observer?.disconnect();
      el?.remove();
      el = canvas = image = undefined;
      host = undefined;
    },
  };

  return {
    overlay,
    place: where,
    paint(ctx, width, height) {
      // The same place on a picture of another size: sizes scale with the picture's height.
      const size = fontPx(height);
      const p = where();
      if (options.mode === 'static' && image !== undefined && image.complete && image.naturalWidth > 0) {
        ctx.globalAlpha = opacity;
        ctx.drawImage(image, p.x * width, p.y * height, p.w * width, p.h * height);
        ctx.globalAlpha = 1;
        return;
      }
      drawText(ctx, p.x * width, p.y * height, size);
    },
  };
}

/** The legacy factory (a static text mark): `createWatermark({ mode: 'static', ... }).overlay`. */
export function createWatermarkOverlay(options: Partial<WatermarkOptions> = {}): Overlay {
  return createWatermark({ mode: 'static', ...options }).overlay;
}

export interface PipComposite {
  /** The canvas to hand to bindCanvasPip: the picture with the watermark on it. */
  readonly canvas: HTMLCanvasElement;
  destroy(): void;
}

/**
 * Video PiP with the watermark (it would show the bare <video>): the picture and the watermark
 * drawn into a canvas at the picture's own size, at the display rate while that canvas is in PiP
 * and twice a second otherwise (the stream video stays ready for PiP to open in the gesture).
 */
export function createPipComposite(doc: Document, picture: () => HTMLVideoElement | HTMLCanvasElement | undefined, watermark: Watermark): PipComposite {
  const canvas = doc.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  // A first frame at once: a stream video without one delays the page's load event (Chromium)
  // and has no metadata for PiP.
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const win = doc.defaultView;
  let stopped = false;
  let last = 0;
  const draw = (now: number): void => {
    if (stopped) return;
    win?.requestAnimationFrame(draw);
    const inPip = (doc.pictureInPictureElement as HTMLVideoElement | null)?.dataset['otterPip'] !== undefined;
    if (!inPip && now - last < 500) return;
    last = now;
    const src = picture();
    if (src === undefined) return;
    const w = src instanceof HTMLVideoElement ? src.videoWidth : src.width;
    const h = src instanceof HTMLVideoElement ? src.videoHeight : src.height;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(src, 0, 0, w, h);
    watermark.paint(ctx, w, h);
  };
  win?.requestAnimationFrame(draw);
  return {
    canvas,
    destroy() {
      stopped = true;
    },
  };
}
