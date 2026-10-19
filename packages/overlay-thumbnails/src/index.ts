// Seek-preview thumbnails (SPEC §14.2, ADR-007 §7): providers for ui-core's preview card. A WebVTT
// thumbnail track (`sprite.jpg#xywh=x,y,w,h` cues, parsed with media-captions, L1) or the engine's
// HLS I-frame playlist; `createThumbnails` picks per source. The shell passes the provider to
// ui-core with provideThumbnails(root, provider).

import type { Source, Thumbnail, ThumbnailProvider } from '@otter-player/media';

interface Tile {
  readonly start: number;
  readonly end: number;
  readonly thumbnail: Thumbnail;
}

export interface VttThumbnailsOptions {
  /** URL of the WebVTT thumbnail track; image URLs in it resolve against it. */
  readonly src: string;
  /** Injectable for tests. */
  readonly fetch?: (url: string) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;
}

const XYWH = /#xywh=(?:pixel:)?(\d+),(\d+),(\d+),(\d+)$/;

/** Sprite tiles from a WebVTT thumbnail track; fetched and parsed on the first request. */
export function createVttThumbnails(options: VttThumbnailsOptions): ThumbnailProvider {
  let tiles: Promise<readonly Tile[]> | undefined;
  const load = async (): Promise<readonly Tile[]> => {
    const res = await (options.fetch ?? ((url: string) => fetch(url)))(options.src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const [{ parseText }, body] = await Promise.all([import('media-captions'), res.text()]);
    const base = new URL(options.src, globalThis.location?.href);
    const { cues } = await parseText(body, { strict: false });
    return cues
      .map((c) => {
        const ref = c.text.trim();
        const m = XYWH.exec(ref);
        const url = new URL(m === null ? ref : ref.slice(0, m.index), base).href;
        const [x, y, w, h] = m === null ? [0, 0, 0, 0] : m.slice(1).map(Number);
        return { start: c.startTime, end: c.endTime, thumbnail: { url, x: x ?? 0, y: y ?? 0, w: w ?? 0, h: h ?? 0 } };
      })
      .sort((a, b) => a.start - b.start);
  };
  return {
    async at(time) {
      tiles ??= load();
      try {
        return (await tiles).find((t) => t.start <= time && time < t.end)?.thumbnail ?? null;
      } catch {
        // Missing or broken track: the card shows the time only.
        return null;
      }
    },
  };
}

export interface ThumbnailsOptions {
  /** Reads the current source (the media slice). */
  readonly store: { getState(): { readonly source?: Source | null } };
  /** The media plugin: its `thumbnails()` is the engine's I-frame playlist. */
  readonly media?: { thumbnails(): ThumbnailProvider | null };
  readonly fetch?: VttThumbnailsOptions['fetch'];
}

/** The source's WebVTT thumbnail track when it has one, otherwise the engine's I-frames. */
export function createThumbnails(options: ThumbnailsOptions): ThumbnailProvider {
  let vtt: { readonly src: string; readonly provider: ThumbnailProvider } | undefined;
  return {
    at(time) {
      const src = options.store.getState().source?.thumbnails?.src;
      if (src !== undefined) {
        if (vtt?.src !== src) vtt = { src, provider: createVttThumbnails(options.fetch === undefined ? { src } : { src, fetch: options.fetch }) };
        return vtt.provider.at(time);
      }
      return options.media?.thumbnails()?.at(time) ?? Promise.resolve(null);
    },
  };
}
