// Surface (SPEC §12): the pixel layer. VideoSurface for native / MSE, CanvasSurface (2D) as the
// WebCodecs fallback and snapshot path, GPUSurface (WebGL2 / WebGPU) for the WebCodecs main path,
// multi-view grids and HDR. Sizing is ResizeObserver + CSS aspect-ratio only, never window.resize.

import { notImplemented, type Unsubscribe } from '@otter-player/core';

export type SurfaceKind = 'video' | 'canvas2d' | 'gpu';

export type SurfaceFit = 'contain' | 'cover' | 'fill' | 'none' | { ratio: number };

export interface SurfaceTransform {
  rotate: 0 | 90 | 180 | 270;
  mirror: boolean;
  zoom: number;
  pan: [number, number];
}

export interface SurfaceFilters {
  brightness: number;
  contrast: number;
  saturate: number;
  temperature: number;
  sharpen: number;
}

export interface SurfaceColorInfo {
  range: 'sdr' | 'hdr10' | 'hlg' | 'dv';
  gamut: 'srgb' | 'p3' | 'rec2020';
}

export interface SnapshotOptions {
  type?: 'png' | 'jpeg';
  quality?: number;
}

export interface Surface {
  readonly kind: SurfaceKind;
  readonly element: HTMLVideoElement | HTMLCanvasElement;
  /** Actual picture rectangle, letterboxing excluded. */
  readonly contentRect: DOMRectReadOnly;
  setFit(fit: SurfaceFit): void;
  setTransform(t: SurfaceTransform): void;
  setFilters(f: Partial<SurfaceFilters>): void;
  snapshot(opts?: SnapshotOptions): Promise<Blob>;
  readonly colorInfo: SurfaceColorInfo;
  onContentRectChange(h: (r: DOMRectReadOnly) => void): Unsubscribe;
}

export interface GPUSurfaceOptions {
  /** Defaults to WebGPU when available, else WebGL2. */
  readonly api?: 'webgl2' | 'webgpu';
}

/** Zero rectangle that does not need the DOMRectReadOnly constructor (SSR / Worker safe). */
export const ZERO_RECT: DOMRectReadOnly = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }),
};

const SDR_SRGB: SurfaceColorInfo = { range: 'sdr', gamut: 'srgb' };
const noop: Unsubscribe = () => undefined;

function createStubSurface(
  kind: SurfaceKind,
  element: HTMLVideoElement | HTMLCanvasElement,
  factory: string,
): Surface {
  const fail = (method: string): Error => notImplemented(`@otter-player/surface ${factory}().${method}`);
  return {
    kind,
    element,
    contentRect: ZERO_RECT,
    colorInfo: SDR_SRGB,
    setFit() {
      throw fail('setFit');
    },
    setTransform() {
      throw fail('setTransform');
    },
    setFilters() {
      throw fail('setFilters');
    },
    snapshot: () => Promise.reject(fail('snapshot')),
    onContentRectChange: () => noop,
  };
}

export function createVideoSurface(element: HTMLVideoElement): Surface {
  return createStubSurface('video', element, 'createVideoSurface');
}

export function createCanvasSurface(element: HTMLCanvasElement): Surface {
  return createStubSurface('canvas2d', element, 'createCanvasSurface');
}

export function createGPUSurface(element: HTMLCanvasElement, _options: GPUSurfaceOptions = {}): Surface {
  return createStubSurface('gpu', element, 'createGPUSurface');
}
