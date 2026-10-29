// Preset `surveillance` (SPEC §19「监控多路 + HEVC」): a wall of streams on one GPU canvas (ADR-008 §7),
// each tile its own session on the WebCodecs backend (WebCodecs decoders, the WASM HEVC decoder
// where WebCodecs has no HEVC; one shared decode pool, 16 at a time, more wait), HLS playlists and
// File / Blob sources. The player's controls act on the focused tile (click / Enter), which is the
// only one with sound; double-click / Shift+Enter fills the wall with it. Audio follows the
// backend's rules: muted with no AudioContext before a user gesture, the host's mute wish applied
// at the first one, the context clock with a wall-clock stand-in through device stalls (ADR-008
// §2: F1 / F8 / F9 / F14). FLV / TS live streams do not feed WebCodecs yet (M6 report).
// The default skin is the host's stylesheet: `import '@otter-player/ui-skin-default'`.

import { createWebCodecsBackendFactory } from '@otter-player/backend-webcodecs';
import { createCore, type OtterCore, type QoeHook, type RouteExplanation, type StoreView, type Unsubscribe } from '@otter-player/core';
import { createWasmHevcDecoder } from '@otter-player/decoder-wasm-hevc';
import { createWebCodecsDecoder } from '@otter-player/decoder-webcodecs';
import { createFileFormat } from '@otter-player/format-file';
import { createHlsFormat } from '@otter-player/format-hls';
import { createInputController } from '@otter-player/input';
import { createMediaPlugin, MEDIA_SLICE, type LoadOptions, type MediaActionMap, type MediaState, type Source } from '@otter-player/media';
import { createPresentationPlugin, PRESENTATION_SLICE } from '@otter-player/presentation';
import { createFocusStore, createMultiview, type Multiview, type MultiviewTile } from '@otter-player/presentation/multiview';
import { createQoePlugin, QOE_SLICE, type QoeState } from '@otter-player/qoe';
import { createVideoSurface } from '@otter-player/surface';
import { bindActivity, CHROME_SLICE, createChromePlugin, defineOtterElements, provideStore } from '@otter-player/ui-core';
import type { PlayerActions, PlayerState } from './player.js';
import { buildShell } from './shell.js';

type TileState = MediaState & QoeState;

export interface SurveillanceOptions {
  /** The wall's box: the default controls are built inside (an empty container). */
  readonly container: HTMLElement;
  /** One tile per stream: HLS playlist URLs or File / Blob sources. */
  readonly streams: readonly (string | Source)[];
  /** Tile labels (default "Camera n"). */
  readonly labels?: readonly string[];
  /** Columns; default the smallest square that fits. */
  readonly columns?: number;
  readonly title?: string;
  /** Language of the controls (BCP 47), as createPlayer's `lang`. */
  readonly lang?: string;
  /** Control bar auto-hide delay, ms; default 3000. */
  readonly idleMs?: number;
}

export interface SurveillanceTile {
  readonly label: string;
  readonly store: StoreView<TileState, MediaActionMap>;
  readonly qoe: QoeHook;
  /** router.explain() for this tile. */
  explain(): RouteExplanation | null;
}

export interface SurveillancePlayer {
  readonly element: HTMLElement;
  readonly wall: Multiview;
  readonly tiles: readonly SurveillanceTile[];
  /** Resolves once every tile is set up and loading. */
  readonly ready: Promise<void>;
  /** The focused tile (controls, sound), or -1. */
  readonly focused: number;
  focus(i: number): void;
  /** Fills the wall with tile i; undefined: back to the grid. */
  expand(i: number | undefined): void;
  /** Another source on tile i. */
  load(i: number, source: string | Source, options?: LoadOptions): Promise<void>;
  destroy(): Promise<void>;
}

export function createSurveillancePlayer(options: SurveillanceOptions): SurveillancePlayer {
  const root = options.container;
  if (options.lang !== undefined) root.lang = options.lang;
  const video = buildShell(root, true, options.title);
  defineOtterElements();
  const wall = createMultiview({ container: root, label: options.title ?? `${options.streams.length} streams`, ...(options.columns === undefined ? {} : { columns: options.columns }), before: root.querySelector('[data-otter-top]') });
  // The shell: chrome and presentation (fullscreen of the whole wall); media actions go to the
  // focused tile through the focus store.
  const shell: OtterCore<PlayerState, PlayerActions> = createCore<PlayerState, PlayerActions>({
    slices: [MEDIA_SLICE, QOE_SLICE, CHROME_SLICE, PRESENTATION_SLICE],
    plugins: [createChromePlugin({ idleMs: options.idleMs ?? 3000 }), createPresentationPlugin({ container: root, surface: createVideoSurface(video) })],
  });
  const tiles: { tile: MultiviewTile; core: OtterCore<TileState, MediaActionMap> }[] = [];
  const decoders = [createWebCodecsDecoder(), createWasmHevcDecoder()];
  const formats = [createHlsFormat(), createFileFormat()];
  for (let i = 0; i < options.streams.length; i++) {
    const tile = wall.add(options.labels?.[i] ?? `Camera ${i + 1}`);
    const media = createMediaPlugin<TileState, MediaActionMap>({
      target: root.ownerDocument.createElement('video'),
      formats,
      backends: [createWebCodecsBackendFactory({ sink: tile.surface })],
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
    options.streams.forEach((s, i) => views[i]?.dispatch('load', { source: typeof s === 'string' ? { src: s } : s, options: { autoplay: true } }));
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
      views[i]?.dispatch('load', { source: typeof source === 'string' ? { src: source } : source, ...(loadOptions === undefined ? {} : { options: loadOptions }) });
    },
    async destroy() {
      await ready.catch(() => undefined);
      for (const off of offs.splice(0)) off();
      focusStore.destroy();
      for (const t of tiles) await t.core.destroy();
      wall.destroy();
      await shell.destroy();
    },
  };
}
