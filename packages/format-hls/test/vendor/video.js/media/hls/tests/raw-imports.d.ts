// Derived from video.js@92be7bdd72c8782348ebafc765a23cf8d8cba004 packages/spf/src/media/hls/tests/raw-imports.d.ts, Apache-2.0
// Local changes: see UPSTREAM.json in packages/format-hls/src/vendor/video.js.

// Ambient declaration for Vite `?raw` imports, used by tests to load playlist
// fixtures as strings without pulling Node types into the framework-agnostic
// `media` project. Test-only — the media source itself imports no fixtures.
declare module '*?raw' {
  const content: string;

  export default content;
}
