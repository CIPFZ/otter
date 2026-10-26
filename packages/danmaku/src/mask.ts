// Danmaku masks (ADR-012 §6), an on-demand chunk: where the picture's subject is, comments are not
// drawn. Two inputs, both per video frame and looked up by the media time of the picture on
// screen (OverlayHost frame time, requestVideoFrameCallback), so a mask is never more than a frame
// off its picture:
// - SVG frames: [{time, svg}], each an <svg viewBox> with <path d> shapes; parsed without a DOM
//   (path data straight into Path2D), drawn on demand into a small canvas.
// - WebM with alpha (VP8 / VP9 alpha_mode=1): a hidden <video> stepped through the frames ahead
//   of playback (seek per frame: use an all-intra or short-GOP file); opaque alpha is the subject.
// The mask canvas covers the picture rectangle; renderers erase comments under its alpha.

export interface MaskFrame {
  /** Alpha = the subject (comments erased there). */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly index: number;
  /** Changes whenever the canvas content does. */
  readonly version: number;
}

export interface MaskSource {
  readonly kind: 'svg' | 'webm';
  /** Mask of the picture at media time `t`, undefined while not decoded yet. */
  at(t: number): MaskFrame | undefined;
  destroy(): void;
}

export interface SvgMaskFrame {
  /** Media seconds the frame starts at. */
  readonly time: number;
  readonly svg: string;
}

/** Mask resolution: enough for subject shapes, small to upload every frame. */
const MASK_W = 320;

const newCanvas = (doc: Document, w: number, h: number): HTMLCanvasElement | OffscreenCanvas => {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = doc.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Last frame starting at or before `t` (a millisecond of slack: times rounded to the ms). */
function frameAt(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0 || t + 1e-3 < (times[0] as number)) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((times[mid] as number) <= t + 1e-3) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function createSvgMask(doc: Document, input: readonly SvgMaskFrame[]): MaskSource {
  const frames = [...input].sort((a, b) => a.time - b.time);
  const times = frames.map((f) => f.time);
  let canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
  let drawn = -1;
  let version = 0;
  return {
    kind: 'svg',
    at(t) {
      const i = frameAt(times, t);
      if (i < 0) return undefined;
      if (i !== drawn) {
        const svg = (frames[i] as SvgMaskFrame).svg;
        const vb = /viewBox\s*=\s*["']\s*([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([-\d.e]+)/i.exec(svg);
        const [x, y, w, h] = vb === null ? [0, 0, 1, 1] : vb.slice(1, 5).map(Number) as [number, number, number, number];
        const ch = Math.max(1, Math.round((MASK_W * h) / w));
        if (canvas === undefined || canvas.height !== ch) canvas = newCanvas(doc, MASK_W, ch);
        const ctx = canvas.getContext('2d') as Ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(MASK_W / w, 0, 0, ch / h, (-x * MASK_W) / w, (-y * ch) / h);
        ctx.fillStyle = '#000';
        for (const m of svg.matchAll(/\sd\s*=\s*(["'])([^"']*)\1/g)) ctx.fill(new Path2D(m[2] as string));
        drawn = i;
        version++;
      }
      return { canvas: canvas as HTMLCanvasElement | OffscreenCanvas, index: i, version };
    },
    destroy() {
      canvas = undefined;
    },
  };
}

/** Seconds of mask decoded ahead of the picture, and kept behind it. */
const AHEAD_S = 2;
const BEHIND_S = 0.5;

export function createWebmMask(doc: Document, url: string, fps: number, onError: (reason: string) => void): MaskSource {
  const video = doc.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = url;
  // In the document (invisible) so it presents frames: requestVideoFrameCallback says which frame
  // a seek decoded (`seeked` can come before the new frame is there).
  video.setAttribute('aria-hidden', 'true');
  video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  doc.body.append(video);
  const frames = new Map<number, { canvas: HTMLCanvasElement | OffscreenCanvas; version: number }>();
  let version = 0;
  const unreachable = new Set<number>();
  let want = 0;
  let busy = false;
  let ready = false;
  let failed = false;
  let height = 0;
  // A picture's time is its frame's start, possibly rounded to the millisecond: 3 % of a frame of slack.
  const indexOf = (t: number): number => Math.floor(t * fps + 0.03);

  const decode = async (): Promise<void> => {
    if (busy || !ready || failed) return;
    busy = true;
    try {
      for (;;) {
        const from = want;
        const last = Math.min(from + Math.round(AHEAD_S * fps), Math.floor(video.duration * fps) - 1);
        let next = from;
        while (next <= last && (frames.has(next) || unreachable.has(next))) next++;
        if (next > last) break;
        // The middle of the frame's display time: the seek lands on that frame.
        const target = (next + 0.5) / fps;
        // The first presented frame near the target (a callback for an earlier frame can still
        // be pending); none within 250 ms: trust the seek (some engines present nothing hidden).
        const shown = new Promise<number | undefined>((resolve) => {
          if (typeof video.requestVideoFrameCallback !== 'function') return resolve(undefined);
          const timer = setTimeout(() => resolve(undefined), 250);
          const on = (_: number, meta: { mediaTime: number }): void => {
            if (Math.abs(meta.mediaTime - target) <= 1 / fps) {
              clearTimeout(timer);
              resolve(meta.mediaTime);
            } else video.requestVideoFrameCallback(on);
          };
          video.requestVideoFrameCallback(on);
        });
        video.currentTime = target;
        await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
        const decoded = await shown;
        // The frame actually decoded (a seek may land on a neighbour).
        // Chromium reports the frame's start (rounded to the millisecond: the nearest frame);
        // Firefox the time sought, the middle of the frame (that frame).
        const d = decoded === undefined ? next + 0.5 : decoded * fps;
        const index = Math.abs(d - Math.floor(d) - 0.5) < 0.1 ? Math.floor(d) : Math.round(d);
        const c = newCanvas(doc, MASK_W, height);
        (c.getContext('2d') as Ctx).drawImage(video, 0, 0, MASK_W, height);
        if (frames.size === 0 && !hasAlpha(c)) {
          failed = true;
          onError('the WebM has no alpha here (VP8 / VP9 alpha not decoded)');
          return;
        }
        frames.set(index, { canvas: c, version: ++version });
        // A seek that lands elsewhere: that frame is not asked for again (no mask for it rather
        // than a neighbour's).
        if (index !== next) unreachable.add(next);
        for (const k of frames.keys()) if (k < want - BEHIND_S * fps || k > want + AHEAD_S * fps * 2) frames.delete(k);
      }
    } finally {
      busy = false;
    }
  };
  video.addEventListener(
    'loadeddata',
    () => {
      height = Math.max(1, Math.round((MASK_W * video.videoHeight) / Math.max(1, video.videoWidth)));
      ready = true;
      void decode();
    },
    { once: true },
  );
  video.addEventListener('error', () => {
    failed = true;
    onError(`mask video: ${video.error?.message || `error ${video.error?.code ?? ''}`}`);
  });

  return {
    kind: 'webm',
    at(t) {
      const i = indexOf(t);
      if (i !== want) {
        want = i;
        void decode();
      }
      const f = frames.get(i);
      return f === undefined ? undefined : { canvas: f.canvas, index: i, version: f.version };
    },
    destroy() {
      failed = true;
      video.removeAttribute('src');
      video.load();
      video.remove();
      frames.clear();
    },
  };
}

/** Whether a decoded frame has any transparent pixel (alpha decoded at all). */
function hasAlpha(c: HTMLCanvasElement | OffscreenCanvas): boolean {
  const d = (c.getContext('2d') as Ctx).getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if ((d[i] as number) < 250) return true;
  return false;
}
