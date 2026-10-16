// hls.js 1.7 ships no typings for the `./light` export; it has the same API surface as the full build.
declare module 'hls.js/light' {
  export { default } from 'hls.js';
  export * from 'hls.js';
}
