// SPEC §19 短视频 / 简单点播: native or MSE, mp4-range or HLS, minimal skin.
export * from './base.js';
export { createNativeBackendFactory } from '../../packages/backend-native/dist/index.js';
export { createMseBackendFactory } from '../../packages/backend-mse/dist/index.js';
export { createMp4RangeFormat } from '../../packages/format-mp4-range/dist/index.js';
export { createHlsFormat } from '../../packages/format-hls/dist/index.js';
import '../../packages/ui-skin-minimal/dist/index.css';
