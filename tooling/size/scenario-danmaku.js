// SPEC §19 B 站式弹幕站: MSE, DASH with separate audio / video, danmaku.
export * from './base.js';
export { createMseBackendFactory } from '../../packages/backend-mse/dist/index.js';
export { createDashFormat } from '../../packages/format-dash/dist/index.js';
export * from '../../packages/danmaku/dist/index.js';
// Codec probing is in the media session; the viewer's choices persist (ADR-011 batch 3).
export { createPreferencesPlugin } from '../../packages/preferences/dist/index.js';
import '../../packages/ui-skin-default/dist/index.css';
