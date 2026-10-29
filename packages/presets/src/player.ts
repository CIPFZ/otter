// createPlayer (SPEC §16 host contract, ADR-013): the low-level assembly behind the scenario presets.
// One call puts together what a host otherwise wires by hand: the shell around a <video>, the
// playback session, QoE, captions, the chrome, presentation modes, the overlay layer and input, and
// a typed handle to load, observe, explain and destroy. The presets (vod, live, ...) pass their
// formats and backends; a host with its own composition calls it directly.

import { createCore, type CoreEventMap, type EventBus, type OtterCore, type Plugin, type QoeHook, type RouteExplanation, type RouteStep, type StoreSlice, type StoreView, type Unsubscribe } from '@otter-player/core';
import { createInputController, type HotkeyMap } from '@otter-player/input';
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
import { createOverlayLayer, createVideoSurface, trackFrameTime, type OverlayLayer, type Surface } from '@otter-player/surface';
import type { TextActionMap, TextState } from '@otter-player/text';
import { bindActivity, CHROME_SLICE, createChromePlugin, defineOtterElements, provideStore, type ChromeActionMap, type ChromeState } from '@otter-player/ui-core';
import { buildShell } from './shell.js';

/** State of a player made by createPlayer (the slices every preset has). */
export type PlayerState = MediaState & QoeState & TextState & ChromeState & PresentationState;
/** Actions of a player made by createPlayer. */
export type PlayerActions = MediaActionMap & TextActionMap & ChromeActionMap & PresentationActionMap;

export interface PlayerOptions<S extends PlayerState = PlayerState, A extends PlayerActions = PlayerActions> {
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
  /**
   * Language of the controls (BCP 47: `zh-CN`, `en`), set as the player's `lang`. Without it: the
   * page's nearest `lang`, else the browser's language. More languages: provideStrings(root, table).
   */
  readonly lang?: string;
  /** The default controls (true) or a bare <video> (false: the host builds its UI on the store). Default true. */
  readonly controls?: boolean;
  /**
   * Captions (sidecar and in-band tracks, Otter's renderer, CVAA style): an on-demand chunk, loaded
   * while the player starts when on. Default true.
   */
  readonly captions?: boolean;
  /**
   * Start muted (before the first load): browsers allow autoplay only without sound, and the mute
   * must be in place before play(). Default false.
   */
  readonly muted?: boolean;
  /** Control bar auto-hide delay, ms; default 3000; 0 keeps the controls shown. */
  readonly idleMs?: number;
  /** Keyboard mapping instead of SPEC §14.3's defaults (a remote's keys, ...). */
  readonly hotkeys?: HotkeyMap;
  /** Presentation modes: mini window, Document PiP, Media Session... (container and surface are the player's). */
  readonly presentation?: Omit<PresentationPluginOptions, 'container' | 'surface'>;
  /** More state slices and plugins (danmaku, preferences, ...): S and A are the player's state and actions with theirs. */
  readonly slices?: readonly StoreSlice[];
  readonly plugins?: readonly Plugin<S, A>[];
  /** More decision logs for explain(), by name (e.g. the danmaku renderer's steps). */
  readonly explain?: Readonly<Record<string, (state: Readonly<S>) => readonly RouteStep[]>>;
  /** Runs once the player is assembled (overlays, thumbnails, more bindings); may return a cleanup. */
  readonly setup?: (parts: PlayerParts<S, A>) => void | (() => void);
}

/** What `setup` gets: the assembled pieces. */
export interface PlayerParts<S extends PlayerState = PlayerState, A extends PlayerActions = PlayerActions> {
  readonly root: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly surface: Surface;
  readonly layer: OverlayLayer;
  readonly media: MediaPlugin<S, A>;
  readonly store: StoreView<S, A>;
}

/** Everything the player decided and why, in one place (diagnostics, support tickets). */
export interface PlayerExplanation {
  /** router.explain(): format, backend and every step (codecs, fallbacks, hand-overs). */
  readonly route: RouteExplanation | null;
  /** Codec families dropped on this device, and why. */
  readonly codecExcluded: Readonly<Record<string, string>>;
  /** Presentation mode now and what the environment supports. */
  readonly presentation: PresentationState['presentation'];
  /** The last error, if any. */
  readonly error: MediaState['error'];
  /** More decision logs by name (`explain` option: e.g. `danmaku`, the renderer's choices). */
  readonly more: Readonly<Record<string, readonly RouteStep[]>>;
}

export interface Player<S extends PlayerState = PlayerState, A extends PlayerActions = PlayerActions> {
  readonly element: HTMLElement;
  readonly video: HTMLVideoElement;
  /** Read state and dispatch actions (what the UI and framework bindings use). */
  readonly store: StoreView<S, A>;
  readonly events: EventBus<CoreEventMap>;
  readonly qoe: QoeHook;
  /** Resolves once every plugin is installed; `load` before that waits for it. */
  readonly ready: Promise<void>;
  load(source: string | Source, options?: LoadOptions): Promise<void>;
  explain(): PlayerExplanation;
  destroy(): Promise<void>;
}

export function createPlayer<S extends PlayerState = PlayerState, A extends PlayerActions = PlayerActions>(options: PlayerOptions<S, A>): Player<S, A> {
  const root = options.container;
  if (options.lang !== undefined) root.lang = options.lang;
  const video = buildShell(root, options.controls !== false, options.title);
  defineOtterElements();
  const surface = createVideoSurface(video);
  const media = createMediaPlugin<S, A>({
    target: video,
    formats: options.formats,
    backends: options.backends,
    ...(options.decoders === undefined ? {} : { decoders: options.decoders }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.cmcd === undefined ? {} : { cmcd: options.cmcd }),
  });
  // Captions: Otter's renderer, native TextTracks while only the <video> shows (PiP, iPhone
  // fullscreen). An on-demand chunk (ADR-013 §4): the package loads inside this plugin's install
  // (captions off loads nothing), its state goes in before the controller installs, so by `ready`
  // the store looks as with a static slice.
  let textOverlay: Parameters<OverlayLayer['add']>[0] | undefined;
  const text: Plugin<S, A> | undefined =
    options.captions === false
      ? undefined
      : (() => {
          let inner: Plugin<S, A> | undefined;
          return {
            id: 'text',
            async install(ctx) {
              const { createText, TEXT_SLICE } = await import('@otter-player/text');
              ctx.store.setState(TEXT_SLICE.initialState as Partial<S>);
              const t = createText({ inband: media, native: video });
              inner = t.plugin as unknown as Plugin<S, A>;
              textOverlay = t.overlay;
              await inner.install(ctx);
            },
            async uninstall() {
              await inner?.uninstall();
            },
          };
        })();
  const core: OtterCore<S, A> = createCore<S, A>({
    slices: [MEDIA_SLICE, QOE_SLICE, CHROME_SLICE, PRESENTATION_SLICE, ...(options.slices ?? [])],
    plugins: [
      media,
      createQoePlugin(),
      ...(text === undefined ? [] : [text]),
      createChromePlugin({ idleMs: options.idleMs ?? 3000 }),
      createPresentationPlugin({
        ...(options.title === undefined ? {} : { mediaSession: { metadata: { title: options.title } } }),
        ...options.presentation,
        container: root,
        surface,
      }),
      ...(options.plugins ?? []),
    ],
  });
  const store = core.store.view();
  const offs: Unsubscribe[] = [];
  const ready = core.start().then(() => {
    if (options.muted === true) store.dispatch('set-muted', { muted: true });
    root.querySelector('[data-otter-overlays]')?.remove();
    // The presented frame's media time, for frame-exact overlays (danmaku masks).
    const presented = trackFrameTime(video);
    const layer = createOverlayLayer({ container: root, surface, store, mediaTime: () => video.currentTime, frameTime: presented.time });
    if (textOverlay !== undefined) layer.add(textOverlay);
    provideStore(root, store);
    // Keyboard, pointer and touch through one InputController on the root (SPEC §14.3).
    const input = createInputController({ store, ...(options.hotkeys === undefined ? {} : { hotkeys: options.hotkeys }) });
    input.attach(root);
    offs.push(() => input.destroy(), bindActivity(root, store), trackControls(root, store, layer), () => layer.destroy(), () => presented.stop());
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
    explain() {
      const s = store.getState();
      return {
        route: s.route,
        codecExcluded: s.codecExcluded,
        presentation: s.presentation,
        error: s.error,
        more: Object.fromEntries(Object.entries(options.explain ?? {}).map(([name, read]) => [name, read(s)])),
      };
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
