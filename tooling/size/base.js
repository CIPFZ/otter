// Shared base of every SPEC §19 scenario entry: core, playback session, QoE, VideoSurface and the
// ui-core controls (the CSS skin is added per scenario).
export { createCore } from '../../packages/core/dist/index.js';
export { createMediaPlugin, MEDIA_SLICE } from '../../packages/media/dist/index.js';
export { createVideoSurface } from '../../packages/surface/dist/index.js';
export { defineOtterElements, provideStore } from '../../packages/ui-core/dist/index.js';
export { createQoePlugin, QOE_SLICE } from '../../packages/qoe/dist/index.js';
