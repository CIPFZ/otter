// Preset `surveillance` (SPEC §19 row "surveillance walls + HEVC"): a wall of streams on one GPU canvas (ADR-008 §7),
// each tile its own session on the WebCodecs backend (WebCodecs decoders, plus any the host passes
// in `decoders`, e.g. a WASM HEVC decoder where WebCodecs has no HEVC: none ships with Otter, the
// builds available are GPL, ADR-014; one shared decode pool, 16 at a time, more wait), HTTP-FLV /
// WS-FLV and MPEG-TS live streams, HLS playlists and File / Blob sources. The player's controls act on
// the focused tile (click / Enter), which is the only one with sound; double-click / Shift+Enter
// fills the wall with it. More than 6 HTTP-FLV / TS streams from one host need WS-FLV or HTTP/2
// (browsers open 6 HTTP/1.1 connections per host; live streams keep theirs). Audio follows the
// backend's rules: muted with no AudioContext before a user gesture, the host's mute wish applied
// at the first one, the context clock with a wall-clock stand-in through device stalls (ADR-008
// §2: F1 / F8 / F9 / F14). FLV / TS sources are live streams here (`live: true` unless the source
// says `live: false`, which plays through MSE: the WebCodecs FLV / TS demuxers are live-only,
// ADR-013 §7). More than 6 HTTP(S) FLV / TS streams from one origin: a non-fatal
// `tooManyConnectionsPerHost` error on each tile past the sixth.
// The default skin is the host's stylesheet: `import '@otter-player/ui-skin-default'`.

import { createWebCodecsBackendFactory } from '@otter-player/backend-webcodecs';
import { createCore, createError, type OtterCore, type QoeHook, type RouteExplanation, type StoreView, type Unsubscribe } from '@otter-player/core';
import { createWebCodecsDecoder } from '@otter-player/decoder-webcodecs';
import { createFileFormat } from '@otter-player/format-file';
import { createFlvFormat, probeFlv } from '@otter-player/format-flv';
import { createHlsFormat } from '@otter-player/format-hls';
import { createTsFormat, probeTs } from '@otter-player/format-ts';
import { createInputController } from '@otter-player/input';
import { createMediaPlugin, MEDIA_SLICE, type Decoder, type LoadOptions, type MediaActionMap, type MediaState, type Source } from '@otter-player/media';
import { createPresentationPlugin, PRESENTATION_SLICE } from '@otter-player/presentation';
import { createFocusStore, createMultiview, type Multiview, type MultiviewTile } from '@otter-player/presentation/multiview';
import { createQoePlugin, QOE_SLICE, type QoeState } from '@otter-player/qoe';
import { createVideoSurface } from '@otter-player/surface';
import { bindActivity, PLAYER_UI_SLICE, createPlayerUiPlugin, defineOtterElements, provideStore } from '@otter-player/ui-core';
import type { PlayerActions, PlayerState } from './player.js';
import { buildShell } from './shell.js';

type TileState = MediaState & QoeState;

/** Options of the `surveillance` preset. */
export interface SurveillanceOptions {
  /** The wall's box: the default player UI is built inside (an empty container). */
  readonly container: HTMLElement;
  /** One tile per stream: http(s)-flv / ws(s)-flv / live MPEG-TS URLs, HLS playlists, or File / Blob sources. */
  readonly streams: readonly (string | Source)[];
  /**
   * Tile labels.
   * @defaultValue "Camera 1", "Camera 2", ...
   */
  readonly labels?: readonly string[];
  /**
   * Columns of the grid.
   * @defaultValue the smallest square that fits
   */
  readonly columns?: number;
  /**
   * Title in the top bar.
   * @defaultValue none
   */
  readonly title?: string;
  /**
   * Language of the controls (BCP 47), as createPlayer's `lang`.
   * @defaultValue the page's nearest `lang`, else the browser's language
   */
  readonly lang?: string;
  /**
   * Control bar auto-hide delay, ms.
   * @defaultValue `3000`
   */
  readonly idleMs?: number;
  /**
   * Decoders the tiles may use besides WebCodecs' own: a WASM HEVC decoder for devices without HEVC
   * hardware decoding, which the host brings (Otter publishes none: the available builds are GPL).
   * @defaultValue `[]` (WebCodecs only: an HEVC stream on a device without an HEVC decoder reports the non-fatal `hevcDecoderUnavailable` and does not play)
   */
  readonly decoders?: readonly Decoder[];
  /**
   * Live tiles with sound: how far (ms) the decoded audio must be ahead before a tile's clock
   * starts (a minimal jitter buffer, ADR-013 §7). The first frame shows at once as a still; the
   * clock starts once the audio is this far ahead, or 1 s after the first frame at the latest.
   * Fixed, not adaptive. `0`: start at once.
   * @defaultValue `300`
   */
  readonly liveAudioLeadMs?: number;
}

/** One tile of the wall: its own playback session. */
export interface SurveillanceTile {
  /** The tile's label. */
  readonly label: string;
  /** The tile's media and QoE state and its media actions. */
  readonly store: StoreView<TileState, MediaActionMap>;
  /** The tile's QoE events. */
  readonly qoe: QoeHook;
  /** router.explain() for this tile. */
  explain(): RouteExplanation | null;
}

/** A surveillance wall: its tiles, focus and expand, a source per tile. */
export interface SurveillancePlayer {
  /** The wall's root (the container). */
  readonly element: HTMLElement;
  /** The GPU wall the tiles draw on. */
  readonly wall: Multiview;
  /** The tiles, one per stream, in order. */
  readonly tiles: readonly SurveillanceTile[];
  /** Resolves once every tile is set up and loading. */
  readonly ready: Promise<void>;
  /** The focused tile (controls, sound), or -1. */
  readonly focused: number;
  /** Focuses tile i: the controls act on it, and only it has sound. */
  focus(i: number): void;
  /** Fills the wall with tile i; undefined: back to the grid. */
  expand(i: number | undefined): void;
  /** Another source on tile i. */
  load(i: number, source: string | Source, options?: LoadOptions): Promise<void>;
  /** Stops every tile and removes the wall. */
  destroy(): Promise<void>;
}

/** Browsers' HTTP/1.1 connections per origin (RESEARCH §1): endless HTTP streams keep theirs. */
const CONNECTIONS_PER_HOST = 6;

/** The source a tile loads: FLV / TS taken as live unless it says otherwise. */
function tileSource(s: string | Source): Source {
  const source = typeof s === 'string' ? { src: s } : s;
  if (source.live !== undefined || (probeFlv(source) === 0 && probeTs(source) === 0)) return source;
  return { ...source, live: true };
}

/** Per tile: the endless HTTP(S) stream's position among those to its origin (1-based), or 0. */
function httpStreamRanks(sources: readonly Source[], base: string | undefined): number[] {
  const seen = new Map<string, number>();
  return sources.map((s) => {
    if (typeof s.src !== 'string' || s.live !== true) return 0;
    let url: URL;
    try {
      url = new URL(s.src, base);
    } catch {
      return 0;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 0;
    const n = (seen.get(url.origin) ?? 0) + 1;
    seen.set(url.origin, n);
    return n;
  });
}

/**
 * A wall of live streams on one GPU canvas: each tile on the WebCodecs backend (with the host's
 * `decoders`, e.g. a WASM HEVC decoder where WebCodecs has none), HTTP-FLV / WS-FLV / live MPEG-TS
 * / HLS / File sources; the controls act on the focused tile, the only one with sound. More than 6
 * HTTP/1.1 streams from one host need WS-FLV or HTTP/2.
 * @example
 * ```ts
 * import { createSurveillancePlayer } from '@otter-player/presets/surveillance';
 * import '@otter-player/ui-skin-default';
 *
 * // One tile per stream: HTTP-FLV, WS-FLV, live MPEG-TS, HLS.
 * const player = createSurveillancePlayer({ container, title: 'Lobby', streams: sources });
 * ```
 */
export function createSurveillancePlayer(options: SurveillanceOptions): SurveillancePlayer {
  const root = options.container;
  if (options.lang !== undefined) root.lang = options.lang;
  const video = buildShell(root, true, options.title);
  defineOtterElements();
  const surface = createVideoSurface(video);
  const wall = createMultiview({ container: root, label: options.title ?? `${options.streams.length} streams`, ...(options.columns === undefined ? {} : { columns: options.columns }), before: root.querySelector('[data-otter-top]') });
  // The shell: player UI and presentation (fullscreen of the whole wall); media actions go to the
  // focused tile through the focus store.
  const shell: OtterCore<PlayerState, PlayerActions> = createCore<PlayerState, PlayerActions>({
    slices: [MEDIA_SLICE, QOE_SLICE, PLAYER_UI_SLICE, PRESENTATION_SLICE],
    plugins: [createPlayerUiPlugin({ idleMs: options.idleMs ?? 3000 }), createPresentationPlugin({ container: root, surface })],
  });
  const tiles: { tile: MultiviewTile; core: OtterCore<TileState, MediaActionMap> }[] = [];
  const decoders = [createWebCodecsDecoder(), ...(options.decoders ?? [])];
  const formats = [createFlvFormat(), createTsFormat(), createHlsFormat(), createFileFormat()];
  // Prewarm: the decode pool's Workers start with the decoder code loaded while the page sets up,
  // not at the first packet. (The AudioWorklet needs the AudioContext, which waits for a gesture: F1.)
  for (const d of decoders) d.warm?.(options.streams.length);
  for (let i = 0; i < options.streams.length; i++) {
    const tile = wall.add(options.labels?.[i] ?? `Camera ${i + 1}`);
    const media = createMediaPlugin<TileState, MediaActionMap>({
      target: root.ownerDocument.createElement('video'),
      formats,
      backends: [createWebCodecsBackendFactory({ sink: tile.surface, ...(options.liveAudioLeadMs === undefined ? {} : { liveAudioLeadMs: options.liveAudioLeadMs }) })],
      decoders,
      // The tiles draw on the wall's canvas: WebCodecs, not the default MSE first.
      policy: { preferBackend: 'webcodecs' },
    });
    tiles.push({ tile, core: createCore<TileState, MediaActionMap>({ slices: [MEDIA_SLICE, QOE_SLICE], plugins: [media, createQoePlugin()] }) });
  }
  const shellView = shell.store.view();
  const views = tiles.map((t) => t.core.store.view());
  const focusStore = createFocusStore<PlayerState, PlayerActions>(shellView, (views[0] ?? shellView) as unknown as StoreView<PlayerState, PlayerActions>);
  const indexOf = (tile: MultiviewTile | undefined): number => tiles.findIndex((t) => t.tile === tile);
  const offs: Unsubscribe[] = [];
  const onFocus = (tile: MultiviewTile | undefined): void => {
    const i = indexOf(tile);
    if (i < 0) return;
    focusStore.focus(views[i] as unknown as StoreView<PlayerState, PlayerActions>);
    // Only the focused stream plays sound (a wish until the first gesture, F1).
    views.forEach((v, j) => v.dispatch('set-muted', { muted: j !== i }));
  };
  const ready = (async () => {
    await shell.start();
    for (const t of tiles) await t.core.start();
    provideStore(root, focusStore.view);
    const input = createInputController({ store: focusStore.view });
    input.attach(root);
    offs.push(wall.on('focus', onFocus), () => input.destroy(), bindActivity(root, focusStore.view));
    onFocus(wall.focused);
    const sources = options.streams.map(tileSource);
    // Past the sixth endless HTTP stream to one origin the browser holds the request until another
    // ends, which a live stream never does: said, not silent (HTTP/2 servers are not limited).
    httpStreamRanks(sources, root.ownerDocument.defaultView?.location.href).forEach((rank, i) => {
      if (rank <= CONNECTIONS_PER_HOST) return;
      const error = createError({
        type: 'network',
        details: 'tooManyConnectionsPerHost',
        fatal: false,
        recoverable: false,
        // Which stream the browser holds back is its choice (the order the requests go out), not
        // necessarily this one: the warning goes on each stream past the sixth in the list.
        message: `stream ${i + 1} is HTTP stream ${rank} to its host: browsers open ${CONNECTIONS_PER_HOST} HTTP/1.1 connections per host and live streams keep theirs, so one of them waits (use WS-FLV or HTTP/2)`,
      });
      tiles[i]?.core.qoe.emit('error', { error, fallback: [] });
    });
    sources.forEach((source, i) => views[i]?.dispatch('load', { source, options: { autoplay: true } }));
  })();
  return {
    element: root,
    wall,
    tiles: tiles.map((t, i) => ({
      label: t.tile.label,
      store: views[i] as StoreView<TileState, MediaActionMap>,
      qoe: t.core.qoe,
      explain: () => t.core.store.getState().route,
    })),
    ready,
    get focused() {
      return indexOf(wall.focused);
    },
    focus(i) {
      const t = tiles[i];
      if (t !== undefined) wall.focus(t.tile);
    },
    expand(i) {
      wall.expand(i === undefined ? undefined : tiles[i]?.tile);
    },
    async load(i, source, loadOptions) {
      await ready;
      views[i]?.dispatch('load', { source: tileSource(source), ...(loadOptions === undefined ? {} : { options: loadOptions }) });
    },
    async destroy() {
      await ready.catch(() => undefined);
      for (const off of offs.splice(0)) off();
      focusStore.destroy();
      for (const t of tiles) await t.core.destroy();
      wall.destroy();
      try {
        await shell.destroy();
      } finally {
        surface.destroy();
      }
    },
  };
}
