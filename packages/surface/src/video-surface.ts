// VideoSurface (SPEC §12): the <video> element as the picture layer for the native and MSE
// backends. Fit / transform / filters are CSS on the element; contentRect is the actual picture
// rectangle (letterbox excluded) relative to the element box, which overlays use to stay on the
// picture. Sizes come from ResizeObserver and media events, never window.resize.

import { createError, createEventBus, type Unsubscribe } from '@otter-player/core';
import type { SnapshotOptions, Surface, SurfaceColorInfo, SurfaceFilters, SurfaceFit, SurfaceTransform } from './surface.js';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface PictureRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const IDENTITY_TRANSFORM: SurfaceTransform = { rotate: 0, mirror: false, zoom: 1, pan: [0, 0] };

const quarterTurn = (t: SurfaceTransform): boolean => t.rotate === 90 || t.rotate === 270;

/** Picture rectangle for `fit` before zoom / pan; `intrinsic` already accounts for rotation. */
function fitRect(box: Size, intrinsic: Size, fit: SurfaceFit): PictureRect {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  if (fit === 'fill' || intrinsic.width <= 0 || intrinsic.height <= 0) return { x: 0, y: 0, width: box.width, height: box.height };
  const aspect = typeof fit === 'object' ? fit.ratio : intrinsic.width / intrinsic.height;
  let width: number;
  let height: number;
  if (fit === 'none') {
    width = intrinsic.width;
    height = intrinsic.height;
  } else {
    const byWidth = box.width / aspect <= box.height;
    // contain / ratio: fit inside the box; cover: fill it.
    const fitWidth = fit === 'cover' ? !byWidth : byWidth;
    width = fitWidth ? box.width : box.height * aspect;
    height = fitWidth ? box.width / aspect : box.height;
  }
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/** Actual picture rectangle inside the element box, after fit, rotation, zoom and pan. */
export function computeContentRect(box: Size, video: Size, fit: SurfaceFit, t: SurfaceTransform = IDENTITY_TRANSFORM): PictureRect {
  const intrinsic = quarterTurn(t) ? { width: video.height, height: video.width } : video;
  const base = fitRect(box, intrinsic, fit);
  const width = base.width * t.zoom;
  const height = base.height * t.zoom;
  return {
    x: base.x - (width - base.width) / 2 + t.pan[0],
    y: base.y - (height - base.height) / 2 + t.pan[1],
    width,
    height,
  };
}

/**
 * CSS for the element. The browser renders the unrotated picture with `object-fit`; extra scale
 * makes the rotated (or forced-ratio) picture land exactly on computeContentRect.
 */
export function surfaceCss(box: Size, video: Size, fit: SurfaceFit, t: SurfaceTransform): { objectFit: string; transform: string } {
  const objectFit = typeof fit === 'object' ? 'fill' : fit;
  const target = computeContentRect(box, video, fit, { ...t, zoom: 1, pan: [0, 0] });
  const rendered = fitRect(box, video, typeof fit === 'object' ? 'fill' : fit);
  let sx = 1;
  let sy = 1;
  if (rendered.width > 0 && rendered.height > 0) {
    const [rw, rh] = quarterTurn(t) ? [rendered.height, rendered.width] : [rendered.width, rendered.height];
    sx = target.width / rw;
    sy = target.height / rh;
  }
  const parts = [
    t.pan[0] !== 0 || t.pan[1] !== 0 ? `translate(${t.pan[0]}px, ${t.pan[1]}px)` : '',
    t.zoom !== 1 ? `scale(${t.zoom})` : '',
    t.rotate !== 0 ? `rotate(${t.rotate}deg)` : '',
    Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6 ? `scale(${round(sx)}, ${round(sy)})` : '',
    t.mirror ? 'scaleX(-1)' : '',
  ].filter((p) => p !== '');
  return { objectFit, transform: parts.join(' ') };
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

const NEUTRAL: SurfaceFilters = { brightness: 1, contrast: 1, saturate: 1, temperature: 0, sharpen: 0 };

/** CSS filter string; temperature and sharpen have no CSS equivalent on a <video>. */
export function filterCss(f: SurfaceFilters): string {
  return [
    f.brightness !== 1 ? `brightness(${f.brightness})` : '',
    f.contrast !== 1 ? `contrast(${f.contrast})` : '',
    f.saturate !== 1 ? `saturate(${f.saturate})` : '',
  ]
    .filter((p) => p !== '')
    .join(' ');
}

const toDomRect = (r: PictureRect): DOMRectReadOnly =>
  typeof DOMRectReadOnly === 'function'
    ? new DOMRectReadOnly(r.x, r.y, r.width, r.height)
    : {
        ...r,
        top: r.y,
        left: r.x,
        right: r.x + r.width,
        bottom: r.y + r.height,
        toJSON: () => r,
      };

interface SurfaceEvents {
  rect: DOMRectReadOnly;
}

const SDR_SRGB: SurfaceColorInfo = { range: 'sdr', gamut: 'srgb' };

export function createVideoSurface(element: HTMLVideoElement): Surface {
  const bus = createEventBus<SurfaceEvents>();
  let fit: SurfaceFit = 'contain';
  let transform: SurfaceTransform = IDENTITY_TRANSFORM;
  let filters: SurfaceFilters = NEUTRAL;
  let rect: PictureRect = { x: 0, y: 0, width: 0, height: 0 };

  const box = (): Size => ({ width: element.clientWidth, height: element.clientHeight });
  const video = (): Size => ({ width: element.videoWidth, height: element.videoHeight });

  const apply = (): void => {
    const css = surfaceCss(box(), video(), fit, transform);
    element.style.objectFit = css.objectFit;
    element.style.transform = css.transform;
    element.style.transformOrigin = 'center';
    const next = computeContentRect(box(), video(), fit, transform);
    if (next.x !== rect.x || next.y !== rect.y || next.width !== rect.width || next.height !== rect.height) {
      rect = next;
      bus.emit('rect', toDomRect(rect));
    }
  };

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : undefined;
  observer?.observe(element);
  for (const type of ['loadedmetadata', 'resize']) element.addEventListener(type, apply);
  apply();

  return {
    kind: 'video',
    element,
    get contentRect() {
      return toDomRect(rect);
    },
    colorInfo: SDR_SRGB,
    setFit(next) {
      fit = next;
      apply();
    },
    setTransform(next) {
      transform = next;
      apply();
    },
    setFilters(patch) {
      filters = { ...filters, ...patch };
      element.style.filter = filterCss(filters);
      const unsupported = (['temperature', 'sharpen'] as const).filter((k) => patch[k] !== undefined && patch[k] !== 0);
      if (unsupported.length > 0) {
        throw createError({
          type: 'other',
          details: 'filterUnsupported',
          fatal: false,
          recoverable: true,
          message: `${unsupported.join(', ')} need a canvas or GPU surface; VideoSurface only has CSS filters`,
        });
      }
    },
    snapshot(opts: SnapshotOptions = {}) {
      return new Promise<Blob>((resolve, reject) => {
        const canvas = element.ownerDocument.createElement('canvas');
        canvas.width = element.videoWidth;
        canvas.height = element.videoHeight;
        const fail = (cause: unknown, details: string): void =>
          reject(createError({ type: 'other', details, fatal: false, recoverable: false, message: details, cause }));
        try {
          const ctx = canvas.getContext('2d');
          if (ctx === null || canvas.width === 0) {
            fail(undefined, 'snapshotUnavailable');
            return;
          }
          ctx.drawImage(element, 0, 0);
          // Throws SecurityError for cross-origin media without CORS (SPEC §12 VideoSurface limits).
          canvas.toBlob(
            (blob) => (blob === null ? fail(undefined, 'snapshotFailed') : resolve(blob)),
            `image/${opts.type ?? 'png'}`,
            opts.quality,
          );
        } catch (err) {
          fail(err, 'snapshotTainted');
        }
      });
    },
    onContentRectChange: (h): Unsubscribe => bus.on('rect', (r) => h(r)),
    destroy() {
      observer?.disconnect();
      for (const type of ['loadedmetadata', 'resize']) element.removeEventListener(type, apply);
      bus.clear();
    },
  };
}
