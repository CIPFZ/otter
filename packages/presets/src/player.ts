// createPlayer (SPEC §16 host contract, ADR-013): one call assembles what a host otherwise wires by
// hand: the shell around a <video>, the playback session, QoE, captions, the chrome, presentation
// modes, the overlay layer and input, and a typed handle to load, observe and destroy. The scenario
// presets (vod, live, ...) call it with their formats and backends; hosts can call it directly.

import { createCore, type CoreEventMap, type EventBus, type OtterCore, type Plugin, type QoeHook, type StoreSlice, type StoreView, type Unsubscribe } from '@otter-player/core';
import { createInputController } from '@otter-player/input';
import {
  createMediaPlugin,
  MEDIA_SLICE,
  type BackendFactory,
  type CmcdConfig,
  type Decoder,
  type FormatPlugin,
  type LoadOptions,
  type MediaActionMap,
  type MediaPlugin,
  type MediaState,
  type RoutePolicy,
  type Source,
} from '@otter-player/media';
import { createPresentationPlugin, PRESENTATION_SLICE, type PresentationActionMap, type PresentationPluginOptions, type PresentationState } from '@otter-player/presentation';
import { createQoePlugin, QOE_SLICE, type QoeState } from '@otter-player/qoe';
import { createOverlayLayer, createVideoSurface, type OverlayLayer, type Surface } from '@otter-player/surface';
import { createText, TEXT_SLICE, type TextActionMap, type TextState } from '@otter-player/text';
import { bindActivity, CHROME_SLICE, createChromePlugin, defineOtterElements, provideStore, type ChromeActionMap, type ChromeState } from '@otter-player/ui-core';
import { buildShell } from './shell.js';

/** State of a player made by createPlayer (the slices every preset has). */
export type PlayerState = MediaState & QoeState & TextState & ChromeState & PresentationState;
/** Actions of a player made by createPlayer. */
export type PlayerActions = MediaActionMap & TextActionMap & ChromeActionMap & PresentationActionMap;

export interface PlayerOptions {
  /** The player's root. Empty: the default shell is built inside; with a <video>: its markup is kept. */
  readonly container: HTMLElement;
  readonly formats: readonly FormatPlugin[];
  readonly backends: readonly BackendFactory[];
  readonly decoders?: readonly Decoder[];
  readonly policy?: RoutePolicy;
  /** CMCD request data (CTA-5004), off by default. */
  readonly cmcd?: CmcdConfig;
  /** Top bar and Media Session title. */
  readonly title?: string;
  /** The default controls (true) or a bare <video> (false: the host builds its UI on the store). Default true. */
  readonly controls?: boolean;
  /** Control bar auto-hide delay, ms; default 3000; 0 keeps the controls shown. */
  readonly idleMs?: number;
  /** Presentation modes: mini window, Document PiP, Media Session... (container and surface are the player's). */
  readonly presentation?: Omit<PresentationPluginOptions, 'container' | 'surface'>;
  /** More state slices and plugins (danmaku, preferences, ...). */
  readonly slices?: readonly StoreSlice[];
  readonly plugins?: readonly Plugin<never, never>[];
  /** Runs once the player is assembled (overlays, thumbnails, more bindings); may return a cleanup. */
  readonly setup?: (parts: PlayerParts) => void | (() => void);
}

/** What `setup` gets: the assembled pieces. */
export interface PlayerParts {
  readonly root: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly surface: Surface;
  readonly layer: OverlayLayer;
  readonly media: MediaPlugin<PlayerState, PlayerActions>;
  readonly store: StoreView<PlayerState, PlayerActions>;
}

export interface Player {
  readonly element: HTMLElement;
  readonly video: HTMLVideoElement;
  /** Read state and dispatch actions (what the UI and framework bindings use). */
  readonly store: StoreView<PlayerState, PlayerActions>;
  readonly events: EventBus<CoreEventMap>;
  readonly qoe: QoeHook;
  /** Resolves once every plugin is installed; `load` before that waits for it. */
  readonly ready: Promise<void>;
  load(source: string | Source, options?: LoadOptions): Promise<void>;
  destroy(): Promise<void>;
}

export function createPlayer(options: PlayerOptions): Player {
  const root = options.container;
  const video = buildShell(root, options.controls !== false, options.title);
  defineOtterElements();
  const surface = createVideoSurface(video);
  const media = createMediaPlugin<PlayerState, PlayerActions>({
    target: video,
    formats: options.formats,
    backends: options.backends,
    ...(options.decoders === undefined ? {} : { decoders: options.decoders }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.cmcd === undefined ? {} : { cmcd: options.cmcd }),
  });
  // Captions: Otter's renderer, native TextTracks while only the <video> shows (PiP, iPhone fullscreen).
  const text = createText({ inband: media, native: video });
  const core: OtterCore<PlayerState, PlayerActions> = createCore<PlayerState, PlayerActions>({
    slices: [MEDIA_SLICE, QOE_SLICE, TEXT_SLICE, CHROME_SLICE, PRESENTATION_SLICE, ...(options.slices ?? [])],
    plugins: [
      media,
      createQoePlugin(),
      text.plugin,
      createChromePlugin({ idleMs: options.idleMs ?? 3000 }),
      createPresentationPlugin({
        ...(options.title === undefined ? {} : { mediaSession: { metadata: { title: options.title } } }),
        ...options.presentation,
        container: root,
        surface,
      }),
      ...((options.plugins ?? []) as readonly Plugin<PlayerState, PlayerActions>[]),
    ],
  });
  const store = core.store.view();
  const offs: Unsubscribe[] = [];
  const ready = core.start().then(() => {
    root.querySelector('[data-otter-overlays]')?.remove();
    const layer = createOverlayLayer({ container: root, surface, store, mediaTime: () => video.currentTime });
    layer.add(text.overlay);
    provideStore(root, store);
    // Keyboard, pointer and touch through one InputController on the root (SPEC §14.3).
    const input = createInputController({ store });
    input.attach(root);
    offs.push(() => input.destroy(), bindActivity(root, store), trackControls(root, store, layer), () => layer.destroy());
    const cleanup = options.setup?.({ root, video, surface, layer, media, store });
    if (cleanup !== undefined) offs.push(cleanup);
  });
  return {
    element: root,
    video,
    store,
    events: core.events,
    qoe: core.qoe,
    ready,
    async load(source, loadOptions) {
      await ready;
      store.dispatch('load', { source: typeof source === 'string' ? { src: source } : source, ...(loadOptions === undefined ? {} : { options: loadOptions }) });
    },
    async destroy() {
      await ready.catch(() => undefined);
      for (const off of offs.splice(0)) off();
      await core.destroy();
    },
  };
}

/**
 * Controls fade out when the chrome says so (they stay in the tab order; focusing one shows them
 * again), and the visible bar is the overlays' safe area (captions move above it).
 */
function trackControls(root: HTMLElement, store: StoreView<PlayerState, PlayerActions>, layer: OverlayLayer): Unsubscribe {
  const controls = root.querySelector<HTMLElement>('[data-otter-controls]');
  if (controls === null) return () => undefined;
  const chrome = [...root.querySelectorAll<HTMLElement>('[data-otter-top], [data-otter-center]')];
  let last: boolean | undefined;
  const report = (): void => {
    const visible = store.getState().controlsVisible;
    controls.toggleAttribute('data-idle', !visible);
    for (const el of chrome) el.toggleAttribute('data-idle', !visible);
    layer.setSafeArea({ top: 0, right: 0, bottom: visible ? controls.offsetHeight : 0, left: 0 });
  };
  const observer = new ResizeObserver(report);
  observer.observe(controls);
  const off = store.subscribe((s) => {
    if (s.controlsVisible === last) return;
    last = s.controlsVisible;
    report();
  });
  report();
  return () => {
    observer.disconnect();
    off();
  };
}
