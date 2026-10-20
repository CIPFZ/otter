// @otter-player/surface/gpu: frame sinks for the WebCodecs backend (GPUSurface on WebGL2, the
// Canvas 2D fallback, multi-view grids) and the filter math. A separate entry so pages that only
// play through <video> do not carry it (ADR-008 §6).

export {
  createCanvasSurface,
  createFrameSurface,
  createGPUGrid,
  createGPUSurface,
  FULL_REGION,
  gpuContextCount,
  type FrameSurface,
  type GPUGrid,
  type GPUGridOptions,
  type GPUView,
  type Region,
} from './gpu-surface.js';
export { createGlRenderer, frameSize, isI420, type GlRenderer, type I420Frame, type PixelRect, type SurfaceFrame, type ViewDraw } from './gl-renderer.js';
export { colorMatrix, sharpenKernel, svgFilterMarkup, type ColorMatrix } from './filters.js';
