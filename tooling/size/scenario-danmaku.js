// SPEC §19 B 站式弹幕站: the `danmaku` preset (DASH A/V split on Shaka, HLS, MP4 range, danmaku,
// watermark, preferences) and the default skin (ADR-013). Danmaku's on-demand chunks (parsers,
// WebGL, Worker, masks) are listed apart (ADR-012).
export * from '../../packages/presets/dist/danmaku.js';
import '../../packages/ui-skin-default/dist/index.css';
