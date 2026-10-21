// Player fixture: the M1 composition a host (or a future preset) would build, exposed on
// window.otter so the e2e scenario matrix can drive it. Engine and UI only meet in the store.

import { createCore, type QoeEventMap, type RouteExplanation } from '@otter-player/core';
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
import {
  createMediaPlugin,
  MEDIA_SLICE,
  type CmcdConfig,
  type FrameSink,
  type LoadOptions,
  type MediaActionMap,
  type MediaState,
  type RoutePolicy,
  type Source,
} from '@otter-player/media';
import { createQoePlugin, QOE_SLICE, type QoeState } from '@otter-player/qoe';
import { createOverlayLayer, createVideoSurface, type OverlayLayer, type Surface } from '@otter-player/surface';
import { createFrameSurface, type FrameSurface } from '@otter-player/surface/gpu';
import { createText, TEXT_SLICE, type TextActionMap, type TextState } from '@otter-player/text';
import { createInputController } from '@otter-player/input';
import { createThumbnails } from '@otter-player/overlay-thumbnails';
import { createPresentationPlugin, PRESENTATION_SLICE, type PresentationActionMap, type PresentationState } from '@otter-player/presentation';
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
}

export interface WallFixture {
  readonly kind: 'gpu' | 'canvas2d';
  tiles(): WallTile[];
  focus(index: number): void;
  /** Local fullscreen of tile `index`; -1 back to the grid. */
  expand(index: number): void;
  focused(): number;
  expanded(): number;
  /** Removes tile `index` (its stream stops; a queued decoder may start). */
  remove(index: number): Promise<void>;
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
];

type View = ReturnType<ReturnType<typeof createCore<State, Actions>>['store']['view']>;

/** `bind` (multi-view): the store the controls, input and overlays use instead of the core's. */
async function build(policy: RoutePolicy, bind: (view: View) => View = (v) => v): Promise<{
  core: ReturnType<typeof createCore<State, Actions>>;
  media: ReturnType<typeof createMediaPlugin<State, Actions>>;
  surface: Surface;
  layer: OverlayLayer;
  dispose: () => void;
}> {
  const params = new URLSearchParams(location.search);
  const abr = params.get('abr') === 'engine' ? 'engine' : 'otter';
  // ?ahead=<s>: mp4-range buffer goal (short clips would otherwise be buffered whole).
  const ahead = params.get('ahead') === null ? undefined : Number(params.get('ahead'));
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
    formats: [
      createHlsFormat({ abr }),
      createDashFormat({ abr }),
      createFlvFormat(pipeline === undefined ? {} : { engine: pipeline }),
      createTsFormat(pipeline === undefined ? {} : { engine: pipeline }),
      createMp4RangeFormat(ahead === undefined ? {} : { maxBufferAheadS: ahead }),
      createFileFormat(),
    ],
    backends: [createMseBackendFactory(), createNativeBackendFactory(), createWebCodecsBackendFactory({ sink: frameSink(root) })],
    // WebCodecs (hardware where there is any) first, the WASM decoder for the wasm step.
    // ?hw=off: no video through WebCodecs (hardware decoding switched off); ?wasm=fail: the WASM
    // decoder's files are missing. Both force the fallback chain (ADR-008 §5).
    decoders: [
      createWebCodecsDecoder(params.get('hw') === 'off' ? { disableVideo: true } : {}),
      createWasmHevcDecoder(params.get('wasm') === 'fail' ? { baseUrl: new URL('/missing-wasm-decoder/', location.href) } : {}),
    ],
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
  const view = bind(core.store.view());
  root.querySelector('[data-otter-overlays]')?.remove();
  const layer = createOverlayLayer({ container: root, surface, store: view, mediaTime: () => video.currentTime });
  layer.add(text.overlay);
  provideStore(root, view);
  // Preview card pictures: the source's WebVTT sprite track, else the engine's I-frame playlist.
  provideThumbnails(root, createThumbnails({ store: view, media }));
  // Keyboard, pointer and touch go through one InputController on the player root (SPEC §14.3).
  const input = createInputController({ store: view });
  input.attach(root);
  const offActivity = bindActivity(root, view);
  const offControls = trackControls(view, layer);
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
  const shell = await build({}, (view) => {
    focus = createFocusStore(view, view);
    return focus.view;
  });
  const blob = await (await fetch(src)).blob();
  type TileCore = { core: ReturnType<typeof createCore<MediaState & QoeState, MediaActionMap>>; tile: ReturnType<typeof wall.add>; errors: string[]; dropped: number; decoded: number; loops: number };
  const tiles: TileCore[] = [];
  for (let i = 0; i < count; i++) {
    const tile = wall.add(`Camera ${i + 1}`);
    const media = createMediaPlugin<MediaState & QoeState, MediaActionMap>({
      target: document.createElement('video'),
      formats: [createFileFormat()],
      // ?wallsink=none (measurement only): frames are dropped instead of drawn.
      backends: [createWebCodecsBackendFactory({ sink: new URLSearchParams(location.search).get('wallsink') === 'none' ? { draw: (f) => (f as { close?: () => void }).close?.(), clear: () => undefined } : tile.surface })],
      decoders: [createWebCodecsDecoder(), createWasmHevcDecoder()],
    });
    const core = createCore<MediaState & QoeState, MediaActionMap>({ slices: [MEDIA_SLICE, QOE_SLICE], plugins: [media, createQoePlugin()] });
    await core.start();
    const t: TileCore = { core, tile, errors: [], dropped: 0, decoded: 0, loops: 0 };
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
    core.qoe.on('error', (p) => t.errors.push((p as { error: { details: string } }).error.details));
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
    // Only the focused stream plays sound.
    tiles.forEach((t, j) => t.core.store.dispatch('set-muted', { muted: j !== i }));
  };
  wall.on('focus', onFocus);
  onFocus(wall.focused);
  tiles.forEach((t, i) =>
    // Staggered starts, so every tile shows another frame.
    t.core.store.dispatch('load', { source: { src: blob }, options: { autoplay: true, startTime: (i * 0.37) % 8 } }),
  );
  return {
    kind: wall.kind,
    tiles: () =>
      tiles.map((t) => {
        const s = t.core.store.getState();
        const replaced = (t.tile.surface as { framesReplaced?: number }).framesReplaced ?? 0;
        return { label: t.tile.label, status: s.status, backend: s.backend, currentTime: s.currentTime, paused: s.paused, muted: s.muted, dropped: t.dropped, decoded: t.decoded, replaced, loops: t.loops, route: s.route, errors: t.errors };
      }),
    focus: (i) => wall.focus((tiles[i] as TileCore).tile),
    expand: (i) => wall.expand(i < 0 ? undefined : (tiles[i] as TileCore).tile),
    focused: () => indexOf(wall.focused),
    setControlsVisible: (visible) => shell.core.store.setState({ controlsVisible: visible }),
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
else window.otter = start();
