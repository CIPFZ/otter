// Preset `basic` (SPEC §19「短视频 / 简单点播」, ADR-013 §4): the smallest player. Progressive MP4
// (mp4-range) and HLS (the own CMAF-HLS engine; hls.js only for the streams it hands over), on MSE
// with native playback as the fallback; a shell with play / pause, mute, time, the progress bar and
// fullscreen. No DASH, captions, thumbnails, presentation modes or settings menu: a host that needs
// them takes `vod`, or adds slices / plugins / `setup` here. Skin: `@otter-player/ui-skin-minimal`
// (or ui-skin-default).

import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createCore, type CoreEventMap, type EventBus, type OtterCore, type Plugin, type QoeHook, type RouteExplanation, type StoreSlice, type StoreView, type Unsubscribe } from '@otter-player/core';
import { createHlsFormat } from '@otter-player/format-hls';
import { createMp4RangeFormat } from '@otter-player/format-mp4-range';
import { createMediaPlugin, MEDIA_SLICE, type FormatPlugin, type LoadOptions, type MediaActionMap, type MediaPlugin, type MediaState, type Source } from '@otter-player/media';
import type { PresentationSnapshot, PresentationState } from '@otter-player/presentation';
import { createQoePlugin, QOE_SLICE, type QoeState } from '@otter-player/qoe';
import {
  bindActivity,
  CHROME_SLICE,
  createChromePlugin,
  defineElements,
  findStrings,
  otterFullscreenButton,
  otterMuteButton,
  otterPlayButton,
  otterTimeDisplay,
  otterTimeSlider,
  provideStore,
  type ChromeActionMap,
  type ChromeState,
} from '@otter-player/ui-core';

/** Fullscreen only: the part of the presentation state the fullscreen button reads. */
export type BasicFullscreenState = Pick<PresentationState, 'presentation'>;
export type BasicState = MediaState & QoeState & ChromeState & BasicFullscreenState;
export interface BasicActions extends MediaActionMap, ChromeActionMap {
  'toggle-fullscreen': Record<string, never>;
  'exit-fullscreen': Record<string, never>;
}

export interface BasicOptions<S extends BasicState = BasicState, A extends BasicActions = BasicActions> {
  /** The player's root. Empty: the basic shell is built inside; with a <video>: its markup is kept. */
  readonly container: HTMLElement;
  /** More formats after mp4-range and HLS (e.g. `createDashFormat()`). */
  readonly formats?: readonly FormatPlugin[];
  /** The controls (true) or a bare <video> (false: the host builds its UI on the store). Default true. */
  readonly controls?: boolean;
  /** Start muted (before the first load; autoplay needs it). Default false. */
  readonly muted?: boolean;
  /** Control bar auto-hide delay, ms; default 3000; 0 keeps the controls shown. */
  readonly idleMs?: number;
  /** Language of the controls (BCP 47), set as the player's `lang` (see createPlayer). */
  readonly lang?: string;
  readonly slices?: readonly StoreSlice[];
  readonly plugins?: readonly Plugin<S, A>[];
  /** Runs once the player is assembled; may return a cleanup. */
  readonly setup?: (parts: { readonly root: HTMLElement; readonly video: HTMLVideoElement; readonly media: MediaPlugin<S, A>; readonly store: StoreView<S, A> }) => void | (() => void);
}

export interface BasicPlayer<S extends BasicState = BasicState, A extends BasicActions = BasicActions> {
  readonly element: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly store: StoreView<S, A>;
  readonly events: EventBus<CoreEventMap>;
  readonly qoe: QoeHook;
  readonly ready: Promise<void>;
  load(source: string | Source, options?: LoadOptions): Promise<void>;
  /** router.explain() and the last error. */
  explain(): { readonly route: RouteExplanation | null; readonly error: MediaState['error'] };
  destroy(): Promise<void>;
}

const SHELL = `<video playsinline crossorigin="anonymous" tabindex="-1"></video>
<div data-otter-controls><otter-time-slider></otter-time-slider>
<div data-otter-group="left"><otter-play-button data-tip-align="start"></otter-play-button><otter-mute-button></otter-mute-button><otter-time-display></otter-time-display></div>
<div data-otter-group="right"><otter-fullscreen-button data-tip-align="end"></otter-fullscreen-button></div></div>`;

const snapshot = (mode: 'inline' | 'fullscreen', fullscreen: 'native' | false): PresentationSnapshot => ({
  mode,
  pending: null,
  capabilities: { inline: 'native', theater: false, fullscreen, pip: false, docpip: false, mini: false, background: false },
  videoOnly: false,
});

/**
 * Fullscreen of the player root (the Fullscreen API), or of the <video> where only that exists
 * (iPhone: `webkitEnterFullscreen`). The state is the presentation slice's shape, so the stock
 * fullscreen button works unchanged.
 */
function createFullscreenPlugin<S extends BasicState, A extends BasicActions>(root: HTMLElement, video: HTMLVideoElement): { slice: StoreSlice<BasicFullscreenState>; plugin: Plugin<S, A> } {
  type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitExitFullscreen?: () => void; webkitDisplayingFullscreen?: boolean };
  const v = video as IosVideo;
  const api = typeof root.requestFullscreen === 'function' && (document as { fullscreenEnabled?: boolean }).fullscreenEnabled !== false;
  const supported = api || typeof v.webkitEnterFullscreen === 'function' ? 'native' : false;
  const on = (): boolean => (api ? document.fullscreenElement === root : v.webkitDisplayingFullscreen === true);
  let offs: Unsubscribe[] = [];
  return {
    slice: { id: 'presentation', initialState: { presentation: snapshot('inline', supported) } },
    plugin: {
      id: 'basic-fullscreen',
      install(ctx) {
        const report = (): void => ctx.store.setState({ presentation: snapshot(on() ? 'fullscreen' : 'inline', supported) } as Partial<S>);
        const enter = (): void => {
          if (api) void root.requestFullscreen().catch(() => undefined);
          else v.webkitEnterFullscreen?.();
        };
        const exit = (): void => {
          if (!on()) return;
          if (api) void document.exitFullscreen().catch(() => undefined);
          else v.webkitExitFullscreen?.();
        };
        const events = ['fullscreenchange', 'webkitbeginfullscreen', 'webkitendfullscreen'];
        for (const e of events) (e === 'fullscreenchange' ? document : video).addEventListener(e, report);
        offs = [
          ctx.store.handle('toggle-fullscreen', () => (on() ? exit() : enter())),
          ctx.store.handle('exit-fullscreen', exit),
          () => {
            for (const e of events) (e === 'fullscreenchange' ? document : video).removeEventListener(e, report);
          },
        ];
      },
      uninstall() {
        for (const off of offs.splice(0)) off();
      },
    },
  };
}

export function createBasicPlayer<S extends BasicState = BasicState, A extends BasicActions = BasicActions>(options: BasicOptions<S, A>): BasicPlayer<S, A> {
  const root = options.container;
  root.setAttribute('data-otter-player', '');
  if (options.lang !== undefined) root.lang = options.lang;
  if (!root.hasAttribute('role')) root.setAttribute('role', 'region');
  if (!root.hasAttribute('aria-label')) root.setAttribute('aria-label', findStrings(root).player);
  if (!root.hasAttribute('tabindex')) root.tabIndex = -1;
  let video = root.querySelector('video');
  if (video === null) {
    root.innerHTML = options.controls === false ? '<video playsinline crossorigin="anonymous" tabindex="-1"></video>' : SHELL;
    video = root.querySelector('video') as HTMLVideoElement;
  }
  defineElements({
    'otter-play-button': otterPlayButton,
    'otter-mute-button': otterMuteButton,
    'otter-time-display': otterTimeDisplay,
    'otter-time-slider': otterTimeSlider,
    'otter-fullscreen-button': otterFullscreenButton,
  });
  const media = createMediaPlugin<S, A>({
    target: video,
    formats: [createMp4RangeFormat(), createHlsFormat(), ...(options.formats ?? [])],
    backends: [createMseBackendFactory(), createNativeBackendFactory()],
  });
  const fullscreen = createFullscreenPlugin<S, A>(root, video);
  const core: OtterCore<S, A> = createCore<S, A>({
    slices: [MEDIA_SLICE, QOE_SLICE, CHROME_SLICE, fullscreen.slice, ...(options.slices ?? [])],
    plugins: [media, createQoePlugin(), createChromePlugin({ idleMs: options.idleMs ?? 3000 }), fullscreen.plugin, ...(options.plugins ?? [])],
  });
  const store = core.store.view();
  const offs: Unsubscribe[] = [];
  const ready = core.start().then(() => {
    if (options.muted === true) store.dispatch('set-muted', { muted: true });
    provideStore(root, store);
    const controls = root.querySelector<HTMLElement>('[data-otter-controls]');
    // The bar fades out when the chrome says so (it stays in the tab order).
    if (controls !== null) offs.push(store.subscribe((s) => controls.toggleAttribute('data-idle', !s.controlsVisible)));
    offs.push(bindActivity(root, store));
    const cleanup = options.setup?.({ root, video, media, store });
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
      return { route: s.route, error: s.error };
    },
    async destroy() {
      await ready.catch(() => undefined);
      for (const off of offs.splice(0)) off();
      await core.destroy();
    },
  };
}
