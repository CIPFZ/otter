// Player fixture: the M1 composition a host (or a future preset) would build, exposed on
// window.otter so the e2e scenario matrix can drive it. Engine and UI only meet in the store.

import { createCore, createError, type QoeEventMap, type RouteExplanation } from '@otter-player/core';
import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createWebCodecsBackendFactory } from '@otter-player/backend-webcodecs';
import { sharedDecodePool } from '@otter-player/decoder-pool';
import { createWasmHevcDecoder } from '@otter-player/decoder-wasm-hevc';
import { createWebCodecsDecoder } from '@otter-player/decoder-webcodecs';
import { createFileFormat } from '@otter-player/format-file';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createDashFormat } from '@otter-player/format-dash';
import { createFlvFormat } from '@otter-player/format-flv';
import { createHlsFormat } from '@otter-player/format-hls';
import { createMp4RangeFormat } from '@otter-player/format-mp4-range';
import { createTsFormat } from '@otter-player/format-ts';
import { createWhepFormat } from '@otter-player/format-whep';
import {
  createMediaPlugin,
  MEDIA_SLICE,
  type CmcdConfig,
  type Decoder,
  type FrameSink,
  type LoadOptions,
  type MediaActionMap,
  type MediaState,
  type RoutePolicy,
  type Source,
} from '@otter-player/media';
import { createQoePlugin, QOE_SLICE, type QoeState } from '@otter-player/qoe';
import { createOverlayLayer, createVideoSurface, trackFrameTime, type OverlayLayer, type Surface } from '@otter-player/surface';
import { createFrameSurface, type FrameSurface } from '@otter-player/surface/gpu';
import { createText, TEXT_SLICE, type TextActionMap, type TextState } from '@otter-player/text';
import { createInputController } from '@otter-player/input';
import { createThumbnails } from '@otter-player/overlay-thumbnails';
import { createPresentationPlugin, PRESENTATION_SLICE, type PresentationActionMap, type PresentationState } from '@otter-player/presentation';
import { bindCanvasPip, canvasPipSupported, type CanvasPip } from '@otter-player/presentation/canvas-pip';
import { createPicturePlugin, PICTURE_SLICE, type PictureActionMap, type PictureSliceState } from '@otter-player/presentation/picture';
import { createSingleAudioPlugin } from '@otter-player/presentation/single-audio';
import { createPreferencesPlugin } from '@otter-player/preferences';
import { createPipComposite, createWatermark, type PipComposite, type Watermark } from '@otter-player/overlay-watermark';
import { createDanmaku, DANMAKU_SLICE, type DanmakuActionMap, type DanmakuInspection, type DanmakuState } from '@otter-player/danmaku';
import {
  bindActivity,
  CHROME_SLICE,
  createChromePlugin,
  defineOtterElements,
  provideStore,
  provideThumbnails,
  type ChromeActionMap,
  type ChromeState,
} from '@otter-player/ui-core';

type State = MediaState & QoeState & TextState & ChromeState & PresentationState & PictureSliceState & DanmakuState;
type Actions = MediaActionMap & TextActionMap & ChromeActionMap & PresentationActionMap & PictureActionMap & DanmakuActionMap;

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
  /** ?danmaku=1: the danmaku engine's frame state. */
  danmaku(): DanmakuInspection | null;
}

export interface WallTile {
  readonly label: string;
  readonly status: string;
  readonly backend: string | null;
  readonly currentTime: number;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly dropped: number;
  readonly decoded: number;
  /** Frames the shared canvas never showed (a newer one replaced them first). */
  readonly replaced: number;
  /** Loops completed (the wall plays its clip in a loop). */
  readonly loops: number;
  readonly route: RouteExplanation | null;
  readonly errors: string[];
  /** The same errors as `details: message`, for a failure's diagnostics. */
  readonly messages: string[];
  /** performance.now() of each error, same order. */
  readonly errorAt: number[];
}

export interface WallFixture {
  readonly kind: 'gpu' | 'canvas2d';
  /** navigator.userActivation.hasBeenActive when the tiles loaded (null: no such API). */
  readonly activatedAtLoad: boolean | null;
  /** Errors of tiles the wall would not take (gpuUnavailable past the 2D limit). */
  readonly refused: readonly string[];
  tiles(): WallTile[];
  focus(index: number): void;
  /** Local fullscreen of tile `index`; -1 back to the grid. */
  expand(index: number): void;
  focused(): number;
  expanded(): number;
  /** Removes tile `index` (its stream stops; a queued decoder may start). */
  remove(index: number): Promise<void>;
  /** Zoom each tile's surface currently has (electronic zoom follows the focus). */
  viewZooms(): number[];
  /** Shows / hides the shell's bars (picture checks read the top of the frames). */
  setControlsVisible(visible: boolean): void;
  /** Dispatches a media action to one tile (not through the focus). */
  dispatchTo(index: number, type: 'play' | 'pause'): void;
  /** Seeks one tile; resolves when its seek finished. */
  seekTile(index: number, time: number): Promise<void>;
  /** The shell's controls see this (shell state + the focused tile's media state). */
  shellState(): State;
  pool(): ReturnType<ReturnType<typeof sharedDecodePool>['stats']>;
  /** Main-thread smoothness over `ms`: rAF intervals and long tasks. */
  measure(ms: number): Promise<{ frames: number; over20: number; over34: number; over50: number; longest: number; longTasks: number; longTaskMs: number }>;
}

declare global {
  interface Window {
    otter?: Promise<OtterFixture>;
    wall?: Promise<WallFixture>;
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
  'audio-yield',
];

type View = ReturnType<ReturnType<typeof createCore<State, Actions>>['store']['view']>;

/**
 * `bind` (multi-view): the store the controls, input and overlays use instead of the core's.
 * `pictureSurface`: the surface the picture controls drive (default: the player's own picture).
 */
async function build(policy: RoutePolicy, bind: (view: View) => View = (v) => v, pictureSurface?: () => Surface | undefined): Promise<{
  core: ReturnType<typeof createCore<State, Actions>>;
  media: ReturnType<typeof createMediaPlugin<State, Actions>>;
  surface: Surface;
  layer: OverlayLayer;
  picture: { refresh(): void };
  danmaku: ReturnType<typeof createDanmaku> | undefined;
  dispose: () => void;
}> {
  const params = new URLSearchParams(location.search);
  const abr = params.get('abr') === 'engine' ? 'engine' : 'otter';
  // ?ahead=<s>: mp4-range / own HLS engine buffer goal (short clips would otherwise be buffered whole).
  const ahead = params.get('ahead') === null ? undefined : Number(params.get('ahead'));
  // ?pipeline=otter|mpegts selects the FLV / TS engine (ADR-007 §2).
  const pipeline = params.get('pipeline') === 'otter' ? 'otter' : params.get('pipeline') === 'mpegts' ? 'mpegts' : undefined;
  // ?cmcd=query|headers enables CMCD (ADR-005 §2) with a fixed session id for assertions.
  const cmcdMode = params.get('cmcd');
  const cmcd: CmcdConfig | undefined =
    cmcdMode === 'query' || cmcdMode === 'headers' ? { enabled: true, mode: cmcdMode, sessionId: 'otter-e2e', contentId: 'fixture' } : undefined;
  const root = document.getElementById('player') as HTMLElement;
  // ?lang=zh-CN: the controls' language (as a preset's `lang` option does).
  const lang = params.get('lang');
  if (lang !== null) root.lang = lang;
  document.body.toggleAttribute('data-scroll', params.get('scroll') === '1');
  const video = root.querySelector('video') as HTMLVideoElement;
  // One surface per page: rebuilding the core (setPolicy) reuses it.
  const surface = (video as HTMLVideoElement & { otterSurface?: Surface }).otterSurface ?? createVideoSurface(video);
  (video as HTMLVideoElement & { otterSurface?: Surface }).otterSurface = surface;
  const media = createMediaPlugin<State, Actions>({
    target: video,
    // ?abr=engine: the engines' own ABR instead of the Otter rule stack, for A/B runs (ADR-005 §1).
    formats: [
      // ?hls=hlsjs: the hls.js adapter instead of the own CMAF-HLS engine (A/B runs, ADR-010).
      createHlsFormat({ abr, ...(params.get('hls') === 'hlsjs' ? { engine: 'hlsjs' as const } : {}), ...(ahead === undefined ? {} : { own: { forwardBufferS: ahead } }) }),
      createDashFormat({ abr }),
      createFlvFormat(pipeline === undefined ? {} : { engine: pipeline }),
      createTsFormat(pipeline === undefined ? {} : { engine: pipeline }),
      createMp4RangeFormat(ahead === undefined ? {} : { maxBufferAheadS: ahead }),
      createFileFormat(),
      // ?ice=ms: the WHEP connect timeout (the ICE-failure case need not wait the default 8 s).
      createWhepFormat(params.get('ice') === null ? {} : { connectTimeoutMs: Number(params.get('ice')) }),
    ],
    backends: [
      createMseBackendFactory(),
      createNativeBackendFactory(),
      // In video PiP the canvas picture is seen even with the page hidden: no background mode.
      createWebCodecsBackendFactory({ sink: frameSink(root), visible: () => document.visibilityState === 'visible' || document.pictureInPictureElement != null }),
    ],
    // WebCodecs (hardware where there is any) first, the WASM decoder for the wasm step.
    // ?hw=off: no video through WebCodecs (hardware decoding switched off); ?wasm=fail: the WASM
    // decoder's files are missing. Both force the fallback chain (ADR-008 §5).
    decoders: [
      faulty(createWebCodecsDecoder(params.get('hw') === 'off' ? { disableVideo: true } : {}), params),
      createWasmHevcDecoder(params.get('wasm') === 'fail' ? { baseUrl: new URL('/missing-wasm-decoder/', location.href) } : {}),
    ],
    policy,
    ...(cmcd === undefined ? {} : { cmcd }),
  });
  // Native TextTracks while only the <video> shows (PiP, iPhone system fullscreen); ?text=native always.
  const text = createText({ inband: media, native: video, ...(params.get('text') === 'native' ? { mode: 'native' as const } : {}) });
  // ?idle=<ms> sets the control auto-hide delay (0 keeps them shown).
  const idleMs = Number(params.get('idle') ?? 3000);
  // Picture controls (SPEC §12 电子放大): zoom, pan and filters of whichever surface shows the
  // picture (the VideoSurface, the WebCodecs canvas, or a wall's focused tile). The zoomed picture
  // stays above the control bar while the bar shows.
  const shown = (): Surface => pictureSurface?.() ?? (root as HTMLElement & { otterFrames?: FrameSurface }).otterFrames ?? surface;
  const controlsBar = root.querySelector<HTMLElement>('[data-otter-controls]');
  const picture = createPicturePlugin<State>({
    surface: shown,
    controlsInset: () => (controlsBar !== null && !controlsBar.hasAttribute('data-idle') ? controlsBar.offsetHeight : 0),
  });
  let canvasPip: CanvasPip | undefined;
  // ?danmaku=1: the danmaku engine (SPEC §13.2), its settings page and its overlay.
  // ?renderer=canvas2d|webgl|worker fixes the danmaku renderer (default auto, ADR-012 §5).
  const danmakuRenderer = params.get('renderer');
  const danmaku =
    params.get('danmaku') === '1'
      ? createDanmaku(danmakuRenderer === 'canvas2d' || danmakuRenderer === 'webgl' || danmakuRenderer === 'worker' ? { renderer: danmakuRenderer } : {})
      : undefined;
  const core = createCore<State, Actions>({
    slices: [MEDIA_SLICE, QOE_SLICE, TEXT_SLICE, CHROME_SLICE, PRESENTATION_SLICE, PICTURE_SLICE, ...(danmaku === undefined ? [] : [DANMAKU_SLICE])],
    plugins: [
      picture,
      media,
      createQoePlugin(),
      text.plugin,
      createChromePlugin({ idleMs }),
      // ?mini=auto: corner window when scrolled out while playing; ?pip=document: Document PiP.
      createPresentationPlugin({
        container: root,
        surface,
        // Video PiP of the WebCodecs canvas: a stream of it (bound below).
        ...(canvasPipSupported(document) ? { pipVideo: () => canvasPip?.pipVideo() } : {}),
        autoMini: params.get('mini') === 'auto',
        preferDocumentPip: params.get('pip') === 'document',
        mediaSession: { metadata: { title: 'Otter Player Demo', artist: 'Otter' } },
      }),
      // One tab of the origin plays with sound (the latest to start).
      createSingleAudioPlugin<State, Actions>(),
      ...(danmaku === undefined ? [] : [danmaku.plugin]),
      // ?prefs=1: the viewer's choices remembered across reloads (localStorage, `otter:` prefix).
      ...(params.get('prefs') === '1' ? [createPreferencesPlugin<State, Actions>()] : []),
    ],
  });
  await core.start();
  // The WebCodecs canvas, while it shows the picture.
  const framesCanvas = (): HTMLCanvasElement | undefined => {
    const frames = (root as HTMLElement & { otterFrames?: FrameSurface }).otterFrames?.element;
    return frames !== undefined && !frames.hidden ? frames : undefined;
  };
  // ?watermark=static|moving (ADR-012 §7): a green test mark; video PiP shows the picture with it
  // (a composite canvas), Document PiP and fullscreen carry the overlay itself.
  const wmMode = params.get('watermark');
  const watermark: Watermark | undefined =
    wmMode === 'static' || wmMode === 'moving'
      ? createWatermark({ mode: wmMode, text: 'OTTER-WM', color: '#00ff00', opacity: 1, fontSize: 40, interval: Number(params.get('wminterval') ?? 8) })
      : undefined;
  const composite: PipComposite | undefined = watermark === undefined ? undefined : createPipComposite(document, () => framesCanvas() ?? video, watermark);
  canvasPip = bindCanvasPip(document, core.store, composite === undefined ? framesCanvas : () => composite.canvas);
  watchPicture(core.store, picture, shown);
  const view = bind(core.store.view());
  root.querySelector('[data-otter-overlays]')?.remove();
  // The picture's own frame time for frame-exact overlays (danmaku masks).
  const presented = trackFrameTime(video);
  const layer = createOverlayLayer({ container: root, surface, store: view, mediaTime: () => video.currentTime, frameTime: presented.time });
  layer.add(text.overlay);
  if (danmaku !== undefined) layer.add(danmaku.overlay);
  if (watermark !== undefined) layer.add(watermark.overlay);
  provideStore(root, view);
  // Preview card pictures: the source's WebVTT sprite track, else the engine's I-frame playlist.
  provideThumbnails(root, createThumbnails({ store: view, media }));
  // Keyboard, pointer and touch go through one InputController on the player root (SPEC §14.3).
  const input = createInputController({ store: view, zoomed: () => (core.store.getState().picture?.zoom ?? 1) > 1 });
  input.attach(root);
  const offActivity = bindActivity(root, view);
  const offControls = trackControls(view, layer);
  return {
    core,
    media,
    surface,
    layer,
    picture,
    danmaku,
    dispose: () => {
      presented.stop();
      composite?.destroy();
      canvasPip?.destroy();
      input.destroy();
      offActivity();
      offControls();
    },
  };
}

/**
 * Re-applies the picture to the surface that shows it whenever that changes (WebCodecs canvas
 * appearing, the wall's focus moving, the control bar showing or hiding).
 */
function watchPicture(store: { subscribe(h: () => void): () => void }, picture: { refresh(): void }, shown: () => Surface): void {
  let last = shown();
  let bar = document.querySelector('[data-otter-controls]')?.hasAttribute('data-idle');
  store.subscribe(() => {
    const now = shown();
    const idle = document.querySelector('[data-otter-controls]')?.hasAttribute('data-idle');
    if (now === last && idle === bar) return;
    last = now;
    bar = idle;
    picture.refresh();
  });
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

/**
 * ?hwfail=<n> / ?hwstall=<n> (test only): the WebCodecs decoder reports a decode error, or stops
 * producing frames, after n packets, as a broken hardware decoder would mid-stream (runtime
 * fallback to WASM, ADR-008 §5).
 */
function faulty(decoder: Decoder, params: URLSearchParams): Decoder {
  const failAt = Number(params.get('hwfail') ?? 0);
  const stallAt = Number(params.get('hwstall') ?? 0);
  if (failAt <= 0 && stallAt <= 0) return decoder;
  return {
    ...decoder,
    create(config) {
      let n = 0;
      let failed = false;
      const inner = decoder.create(config);
      return {
        get state() {
          return inner.state;
        },
        get decodeQueueSize() {
          return inner.decodeQueueSize + (stallAt > 0 && n > stallAt ? n - stallAt : 0);
        },
        decode(chunk) {
          n++;
          if (failAt > 0 && n > failAt) {
            if (!failed) {
              failed = true;
              setTimeout(() => config.error(createError({ type: 'media', details: 'decodeError', fatal: true, recoverable: true, message: `test: decoder broke after ${failAt} packets` })), 0);
            }
            return;
          }
          if (stallAt > 0 && n > stallAt) return;
          inner.decode(chunk);
        },
        flush: () => (stallAt > 0 && n > stallAt ? new Promise<void>(() => undefined) : inner.flush()),
        reset() {
          inner.reset();
        },
        close() {
          inner.close();
        },
      };
    },
  };
}

/**
 * The WebCodecs backend's picture: a canvas over the <video> box, made on the first frame (MSE /
 * native routes never create it). One per player root, reused across rebuilds.
 */
function frameSink(root: HTMLElement): FrameSink {
  const holder = root as HTMLElement & { otterFrames?: FrameSurface };
  const surface = (): FrameSurface => {
    if (holder.otterFrames === undefined) {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('data-otter-frames', '');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
      (root.querySelector('video') as HTMLVideoElement).after(canvas);
      holder.otterFrames = createFrameSurface(canvas);
    }
    return holder.otterFrames;
  };
  // Hidden without a picture: after a fallback from WebCodecs to MSE / native the <video> under
  // it shows again.
  return {
    draw(frame) {
      const s = surface();
      s.element.hidden = false;
      s.draw(frame);
    },
    clear() {
      holder.otterFrames?.clear();
      if (holder.otterFrames !== undefined) holder.otterFrames.element.hidden = true;
    },
  };
}

async function start(): Promise<OtterFixture> {
  defineOtterElements();
  const events: OtterFixture['events'] = [];
  // ?prefer=<backend>: the host's preferBackend (prefer=webcodecs puts the whole chain first).
  const prefer = new URLSearchParams(location.search).get('prefer');
  let current = await build(prefer === 'webcodecs' || prefer === 'mse' || prefer === 'native' ? { preferBackend: prefer } : {});
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
    danmaku: () => current.danmaku?.inspect() ?? null,
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

/** The zoom a surface draws with (its picture rect over the fitted one). */
const zoomOf = (s: Surface): number => {
  const drawn = (s as { drawnRect?: { width: number } }).drawnRect;
  return drawn === undefined || s.contentRect.width === 0 ? 1 : Math.round((drawn.width / s.contentRect.width) * 100) / 100;
};

/**
 * Multi-view wall in the player shell (ADR-008 §7): the page's player keeps its chrome,
 * presentation and input; every tile is its own core (media + QoE) on the WebCodecs backend,
 * drawing into its viewport of one shared canvas, decoding in the shared Worker pool. The controls
 * follow the focused tile (createFocusStore); only the focused tile has sound.
 */
async function startWall(count: number, src: string): Promise<WallFixture> {
  defineOtterElements();
  const { createMultiview, createFocusStore } = await import('@otter-player/presentation/multiview');
  const root = document.getElementById('player') as HTMLElement;
  // Over the gesture / poster layers (tiles take clicks and double-clicks), under the bars.
  const wall = createMultiview({ container: root, label: `${count} streams`, before: root.querySelector('[data-otter-top]') });
  let focus: ReturnType<typeof createFocusStore<State, Actions>> | undefined;
  // The picture controls drive the focused tile's viewport (each tile keeps its own transform:
  // on a focus change the shell applies the picture state to the new tile).
  const shell = await build(
    {},
    (view) => {
      focus = createFocusStore(view, view);
      return focus.view;
    },
    // Before the tiles exist (the shell is built first) the shell's own surface stands in.
    () => wall.focused?.surface ?? wall.tiles[0]?.surface,
  );
  const blob = await (await fetch(src)).blob();
  type TileCore = { core: ReturnType<typeof createCore<MediaState & QoeState, MediaActionMap>>; tile: ReturnType<typeof wall.add>; errors: string[]; messages: string[]; errorAt: number[]; dropped: number; decoded: number; loops: number };
  const tiles: TileCore[] = [];
  const refused: string[] = [];
  for (let i = 0; i < count; i++) {
    let tile: ReturnType<typeof wall.add>;
    try {
      tile = wall.add(`Camera ${i + 1}`);
    } catch (err) {
      // No WebGL2: the wall stops at its 2D limit and says why.
      refused.push((err as { details?: string }).details ?? String(err));
      break;
    }
    const media = createMediaPlugin<MediaState & QoeState, MediaActionMap>({
      target: document.createElement('video'),
      formats: [createFileFormat()],
      // ?wallsink=none (measurement only): frames are dropped instead of drawn.
      backends: [createWebCodecsBackendFactory({ sink: new URLSearchParams(location.search).get('wallsink') === 'none' ? { draw: (f) => (f as { close?: () => void }).close?.(), clear: () => undefined } : tile.surface })],
      decoders: [createWebCodecsDecoder(), createWasmHevcDecoder()],
    });
    const core = createCore<MediaState & QoeState, MediaActionMap>({ slices: [MEDIA_SLICE, QOE_SLICE], plugins: [media, createQoePlugin()] });
    await core.start();
    const t: TileCore = { core, tile, errors: [], messages: [], errorAt: [], dropped: 0, decoded: 0, loops: 0 };
    // The clip loops: at its end, back to the start.
    core.store.select(
      (s) => s.ended,
      (ended) => {
        if (!ended) return;
        t.loops++;
        core.store.dispatch('seek', { time: 0 });
        core.store.dispatch('play', undefined);
      },
    );
    core.qoe.on('error', (p) => {
      const e = (p as { error: { details: string; message?: string } }).error;
      t.errors.push(e.details);
      t.messages.push(`${e.details}: ${e.message ?? ''}`);
      t.errorAt.push(performance.now());
    });
    core.qoe.on('dropped-frames', (p) => {
      t.dropped = (p as { dropped: number }).dropped;
      t.decoded = (p as { total: number }).total;
    });
    tiles.push(t);
  }
  const indexOf = (tile: unknown): number => tiles.findIndex((t) => t.tile === tile);
  const onFocus = (tile: unknown): void => {
    const i = indexOf(tile);
    if (i < 0) return;
    focus?.focus((tiles[i] as TileCore).core.store.view() as unknown as View);
    // A new tile starts from the original picture; zoom and filters belong to the tile they were set on.
    shell.core.store.dispatch('reset-picture', {});
    // Only the focused stream plays sound.
    tiles.forEach((t, j) => t.core.store.dispatch('set-muted', { muted: j !== i }));
  };
  wall.on('focus', onFocus);
  onFocus(wall.focused);
  const activatedAtLoad = (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? null;
  tiles.forEach((t, i) =>
    // Staggered starts, so every tile shows another frame.
    t.core.store.dispatch('load', { source: { src: blob }, options: { autoplay: true, startTime: (i * 0.37) % 8 } }),
  );
  return {
    kind: wall.kind,
    activatedAtLoad,
    refused,
    tiles: () =>
      tiles.map((t) => {
        const s = t.core.store.getState();
        const replaced = (t.tile.surface as { framesReplaced?: number }).framesReplaced ?? 0;
        return { label: t.tile.label, status: s.status, backend: s.backend, currentTime: s.currentTime, paused: s.paused, muted: s.muted, dropped: t.dropped, decoded: t.decoded, replaced, loops: t.loops, route: s.route, errors: t.errors, messages: t.messages, errorAt: t.errorAt };
      }),
    focus: (i) => wall.focus((tiles[i] as TileCore).tile),
    expand: (i) => wall.expand(i < 0 ? undefined : (tiles[i] as TileCore).tile),
    focused: () => indexOf(wall.focused),
    setControlsVisible: (visible) => shell.core.store.setState({ controlsVisible: visible }),
    viewZooms: () => tiles.map((t) => zoomOf(t.tile.surface)),
    dispatchTo: (i, type) => void (tiles[i] as TileCore).core.store.dispatch(type, undefined),
    seekTile: (i, time) =>
      new Promise((resolve) => {
        const store = (tiles[i] as TileCore).core.store;
        store.dispatch('seek', { time });
        const off = store.subscribe((s) => {
          if (s.seeking || Math.abs(s.currentTime - time) > 1e-6) return;
          off();
          resolve();
        });
      }),
    async remove(i) {
      const t = tiles[i] as TileCore;
      tiles.splice(i, 1);
      await t.core.destroy();
      t.tile.remove();
    },
    expanded: () => indexOf(wall.expanded),
    shellState: () => (focus as NonNullable<typeof focus>).view.getState(),
    pool: () => sharedDecodePool().stats(),
    measure: (ms) =>
      new Promise((resolve) => {
        const deltas: number[] = [];
        let longTasks = 0;
        let longTaskMs = 0;
        const observer = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes.includes('longtask') ? new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            longTasks++;
            longTaskMs += e.duration;
          }
        }) : undefined;
        observer?.observe({ type: 'longtask' });
        const t0 = performance.now();
        let last = t0;
        const step = (now: number): void => {
          deltas.push(now - last);
          last = now;
          if (now - t0 < ms) requestAnimationFrame(step);
          else {
            observer?.disconnect();
            resolve({
              frames: deltas.length,
              over20: deltas.filter((d) => d > 20).length,
              over34: deltas.filter((d) => d > 34).length,
              over50: deltas.filter((d) => d > 50).length,
              longest: Math.max(...deltas),
              longTasks,
              longTaskMs,
            });
          }
        };
        requestAnimationFrame((now) => {
          last = now;
          requestAnimationFrame(step);
        });
      }),
  };
}

/**
 * ?chunks=views (test only): response bodies arrive as Uint8Array views into larger buffers
 * (byteOffset > 0), the way a re-chunking source (TransformStream, Service Worker, P2P) can hand
 * them over. Browsers' own fetch chunks are standalone buffers. docs/reports/m3/hlsjs-byteoffset-evidence.md
 */
if (new URLSearchParams(location.search).get('chunks') === 'views') {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    if (res.body === null) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        const big = new Uint8Array(value.byteLength + 8192);
        big.set(value, 4096);
        controller.enqueue(big.subarray(4096, 4096 + value.byteLength));
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

// ?multiview=<n>&src=<url>: a wall of n streams in the player shell (ADR-008 §7).
const wallSize = Number(new URLSearchParams(location.search).get('multiview') ?? 0);
if (wallSize > 0) window.wall = startWall(wallSize, new URLSearchParams(location.search).get('src') ?? '/frames/hevc-720p.mp4');
else {
  window.otter = start();
  // ?load=<url>[&type=<mime>]: load a source at once, for manual checks (play with the Play
  // button: sound needs a user gesture), e.g. ?load=/whep/live&type=application/whep.
  const load = new URLSearchParams(location.search).get('load');
  const type = new URLSearchParams(location.search).get('type');
  if (load !== null) void window.otter.then((o) => o.load({ src: load, ...(type === null ? {} : { type }) }));
}
