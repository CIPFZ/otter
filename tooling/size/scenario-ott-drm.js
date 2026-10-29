// SPEC §19 OTT 付费 + DRM + 离线: the `ott-drm` preset (HLS + DASH, DRM through Shaka, MSE / native)
// and the default skin (ADR-013). Offline storage and ads are not in 1.0.
export * from '../../packages/presets/dist/ott-drm.js';
import '../../packages/ui-skin-default/dist/index.css';
