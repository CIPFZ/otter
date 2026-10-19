// Shared base of every SPEC §19 scenario entry: core, playback session, QoE, VideoSurface and the
// minimal ui-core controls (the CSS skin is added per scenario).
export { createCore } from '../../packages/core/dist/index.js';
export { createMediaPlugin, MEDIA_SLICE } from '../../packages/media/dist/index.js';
export { createVideoSurface } from '../../packages/surface/dist/index.js';
// The minimal control set every scenario shows; richer scenarios add elements themselves.
export {
  defineElements,
  otterMuteButton,
  otterPlayButton,
  otterTimeDisplay,
  otterTimeSlider,
  provideStore,
} from '../../packages/ui-core/dist/index.js';
export { createQoePlugin, QOE_SLICE } from '../../packages/qoe/dist/index.js';
