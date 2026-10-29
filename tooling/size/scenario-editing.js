// SPEC §19 剪辑 / 标注 / 逐帧 (no preset; owner 2026-10-29: measured as a composition): local files
// (format-file, mediabunny on demand) on the WebCodecs backend (frame-accurate seek), WebCodecs
// decoder, a frame surface, preview pictures (overlay-thumbnails), the minimal controls.
export * from './base.js';
export { createWebCodecsBackendFactory } from '../../packages/backend-webcodecs/dist/index.js';
export { createWebCodecsDecoder } from '../../packages/decoder-webcodecs/dist/index.js';
export { createFileFormat } from '../../packages/format-file/dist/index.js';
export { createFrameSurface } from '../../packages/surface/dist/gpu.js';
export { createThumbnails } from '../../packages/overlay-thumbnails/dist/index.js';
import '../../packages/ui-skin-minimal/dist/index.css';
