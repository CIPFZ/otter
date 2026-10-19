// Seek-preview thumbnails (ADR-007 §7): the progress bar's preview card asks a provider for the
// picture at a time. Sources: a WebVTT sprite track (overlay-thumbnails) or the engine's I-frame
// playlist (hls.js). The shell hands the provider to the UI (ui-core provideThumbnails).

/** One tile of a sprite sheet (`w` / `h` 0: the whole image), or a decoded frame. */
export type Thumbnail =
  | { readonly url: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly bitmap: CanvasImageSource & { readonly width: number; readonly height: number } };

export interface ThumbnailProvider {
  /** The picture for `time` (seconds), null when there is none. Calls may be throttled. */
  at(time: number): Promise<Thumbnail | null>;
}
