// Player fixture: the M1 composition a host (or a future preset) would build, exposed on
// window.otter so the e2e scenario matrix can drive it. Engine and UI only meet in the store.

import { createCore, type QoeEventMap, type RouteExplanation } from '@otter-player/core';
import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createWebCodecsBackendFactory } from '@otter-player/backend-webcodecs';
import { createDashFormat } from '@otter-player/format-dash';
import { createFlvFormat } from '@otter-player/format-flv';
import { createHlsFormat } from '@otter-player/format-hls';
import { createMp4RangeFormat } from '@otter-player/format-mp4-range';
import { createTsFormat } from '@otter-player/format-ts';
import {
  createMediaPlugin,
  MEDIA_SLICE,
  type CmcdConfig,
  type LoadOptions,
  type MediaActionMap,
  type MediaState,
  type RoutePolicy,
  type Source,
} from '@otter-player/media';
import { createQoePlugin, QOE_SLICE, type QoeState } from '@otter-player/qoe';
import { createOverlayLayer, createVideoSurface, type OverlayLayer, type Surface } from '@otter-player/surface';
import { createText, TEXT_SLICE, type TextActionMap, type TextState } from '@otter-player/text';
import { createInputController } from '@otter-player/input';
import { createPresentationPlugin, PRESENTATION_SLICE, type PresentationActionMap, type PresentationState } from '@otter-player/presentation';
import {
  bindActivity,
  CHROME_SLICE,
  createChromePlugin,
  defineOtterElements,
  provideStore,
  type ChromeActionMap,
  type ChromeState,
} from '@otter-player/ui-core';

type State = MediaState & QoeState & TextState & ChromeState & PresentationState;
type Actions = MediaActionMap & TextActionMap & ChromeActionMap & PresentationActionMap;

export interface OtterFixture {
  load(source: Source, options?: LoadOptions): void;
  dispatch<K extends keyof Actions>(type: K, payload: Actions[K]): boolean;
  /** Shows / hides the control bar; the shell reports its height as the overlay safe area. */
  setControlsVisible(visible: boolean): void;
  /** Picture rectangle the overlays use (letterbox excluded), relative to the player box. */
  contentRect(): { x: number; y: number; width: number; height: number };
  state(): State;
  explain(): RouteExplanation | null;
  readonly events: { type: keyof QoeEventMap; payload: unknown }[];
  /** Blob of a same-origin URL, for the local-file scenario. */
  fetchBlob(url: string): Promise<Blob>;
  setPolicy(policy: RoutePolicy): Promise<void>;
}

declare global {
  interface Window {
    otter?: Promise<OtterFixture>;
  }
}

const QOE_TYPES: readonly (keyof QoeEventMap)[] = [
  'startup',
  'rebuffer',
  'quality-switch',
  'error',
  'bandwidth',
  'latency',
  'dropped-frames',
  'exit',
  'route',
  'presentation-change',
  'presentation-denied',
];

async function build(policy: RoutePolicy): Promise<{
  core: ReturnType<typeof createCore<State, Actions>>;
  media: ReturnType<typeof createMediaPlugin<State, Actions>>;
  surface: Surface;
  layer: OverlayLayer;
  dispose: () => void;
}> {
  const params = new URLSearchParams(location.search);
  const abr = params.get('abr') === 'engine' ? 'engine' : 'otter';
  // ?pipeline=otter|mpegts selects the FLV / TS engine (ADR-007 §2).
  const pipeline = params.get('pipeline') === 'otter' ? 'otter' : params.get('pipeline') === 'mpegts' ? 'mpegts' : undefined;
  // ?cmcd=query|headers enables CMCD (ADR-005 §2) with a fixed session id for assertions.
  const cmcdMode = params.get('cmcd');
  const cmcd: CmcdConfig | undefined =
    cmcdMode === 'query' || cmcdMode === 'headers' ? { enabled: true, mode: cmcdMode, sessionId: 'otter-e2e', contentId: 'fixture' } : undefined;
  const root = document.getElementById('player') as HTMLElement;
  document.body.toggleAttribute('data-scroll', params.get('scroll') === '1');
  const video = root.querySelector('video') as HTMLVideoElement;
  // One surface per page: rebuilding the core (setPolicy) reuses it.
  const surface = (video as HTMLVideoElement & { otterSurface?: Surface }).otterSurface ?? createVideoSurface(video);
  (video as HTMLVideoElement & { otterSurface?: Surface }).otterSurface = surface;
  const media = createMediaPlugin<State, Actions>({
    target: video,
    // ?abr=engine: the engines' own ABR instead of the Otter rule stack, for A/B runs (ADR-005 §1).
    formats: [createHlsFormat({ abr }), createDashFormat({ abr }), createFlvFormat(pipeline === undefined ? {} : { engine: pipeline }), createTsFormat(pipeline === undefined ? {} : { engine: pipeline }), createMp4RangeFormat()],
    backends: [createMseBackendFactory(), createNativeBackendFactory(), createWebCodecsBackendFactory()],
    policy,
    ...(cmcd === undefined ? {} : { cmcd }),
  });
  // Native TextTracks while only the <video> shows (PiP, iPhone system fullscreen); ?text=native always.
  const text = createText({ inband: media, native: video, ...(params.get('text') === 'native' ? { mode: 'native' as const } : {}) });
  // ?idle=<ms> sets the control auto-hide delay (0 keeps them shown).
  const idleMs = Number(params.get('idle') ?? 3000);
  const core = createCore<State, Actions>({
    slices: [MEDIA_SLICE, QOE_SLICE, TEXT_SLICE, CHROME_SLICE, PRESENTATION_SLICE],
    plugins: [
      media,
      createQoePlugin(),
      text.plugin,
      createChromePlugin({ idleMs }),
      // ?mini=auto: corner window when scrolled out while playing; ?pip=document: Document PiP.
      createPresentationPlugin({
        container: root,
        surface,
        autoMini: params.get('mini') === 'auto',
        preferDocumentPip: params.get('pip') === 'document',
        mediaSession: { metadata: { title: 'Otter Player Demo', artist: 'Otter' } },
      }),
    ],
  });
  await core.start();
  root.querySelector('[data-otter-overlays]')?.remove();
  const layer = createOverlayLayer({ container: root, surface, store: core.store.view(), mediaTime: () => video.currentTime });
  layer.add(text.overlay);
  provideStore(root, core.store.view());
  // Keyboard, pointer and touch go through one InputController on the player root (SPEC §14.3).
  const input = createInputController({ store: core.store.view() });
  input.attach(root);
  const offActivity = bindActivity(root, core.store.view());
  const offControls = trackControls(core.store.view(), layer);
  return {
    core,
    media,
    surface,
    layer,
    dispose: () => {
      input.destroy();
      offActivity();
      offControls();
    },
  };
}

/**
 * Shell duty (SPEC §13.1): controls fade out when the chrome plugin says so (they stay in the
 * tab order; focusing one shows them again), and the visible bar is the overlays' safe area.
 */
function trackControls(store: { getState(): State; subscribe(h: (s: State) => void): () => void }, layer: OverlayLayer): () => void {
  const controls = document.querySelector('[data-otter-controls]') as HTMLElement;
  const chrome = [...document.querySelectorAll<HTMLElement>('[data-otter-top], [data-otter-center]')];
  const report = (): void => {
    const visible = store.getState().controlsVisible;
    controls.toggleAttribute('data-idle', !visible);
    for (const el of chrome) el.toggleAttribute('data-idle', !visible);
    layer.setSafeArea({ top: 0, right: 0, bottom: visible ? controls.offsetHeight : 0, left: 0 });
  };
  const observer = new ResizeObserver(report);
  observer.observe(controls);
  let last = store.getState().controlsVisible;
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

async function start(): Promise<OtterFixture> {
  defineOtterElements();
  const events: OtterFixture['events'] = [];
  let current = await build({});
  const listen = (): void => {
    for (const type of QOE_TYPES) current.core.qoe.on(type, (payload) => events.push({ type, payload }));
  };
  listen();
  const setControlsVisible = (visible: boolean): void => current.core.store.setState({ controlsVisible: visible });

  const toggle = document.getElementById('toggle-stats') as HTMLInputElement;
  const stats = document.querySelector('otter-stats') as HTMLElement;
  toggle.addEventListener('change', () => {
    stats.hidden = !toggle.checked;
  });

  return {
    load: (source, options = {}) => {
      current.core.store.dispatch('load', { source, options });
    },
    dispatch: (type, payload) => current.core.store.dispatch(type, payload),
    state: () => current.core.store.getState(),
    explain: () => current.media.router.explain(),
    events,
    fetchBlob: async (url) => (await fetch(url)).blob(),
    setControlsVisible,
    contentRect: () => {
      const r = current.surface.contentRect;
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    async setPolicy(policy) {
      current.dispose();
      await current.core.destroy();
      current.layer.destroy();
      current = await build(policy);
      listen();
    },
  };
}

window.otter = start();
