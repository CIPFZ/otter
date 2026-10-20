// Surface (SPEC §12): the pixel layer. VideoSurface for native / MSE (./video-surface.ts),
// CanvasSurface (2D) as the WebCodecs fallback and snapshot path, GPUSurface (WebGL2) for the
// WebCodecs main path and multi-view grids (./gpu-surface.ts, ADR-008 §6). Sizing is
// ResizeObserver + CSS aspect-ratio only, never window.resize.

import type { Unsubscribe } from '@otter-player/core';

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
  /** Disconnects observers and listeners; the element itself is left in place. */
  destroy(): void;
}

export interface GPUSurfaceOptions {
  /** WebGL2 (the only API so far; WebGPU is optional per SPEC §12 and not implemented). */
  readonly api?: 'webgl2';
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
