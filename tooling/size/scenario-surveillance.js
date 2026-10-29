// SPEC §19 监控多路 + HEVC: the `surveillance` preset (a multi-view wall on the WebCodecs backend,
// WebCodecs + WASM HEVC decoders, HLS / File) and the default skin. The WASM decoder build is a
// separate download (not counted, as the row says).
export * from '../../packages/presets/dist/surveillance.js';
import '../../packages/ui-skin-default/dist/index.css';
