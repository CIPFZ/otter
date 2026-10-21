// Playback session (SPEC §5.3, ADR-003 §1/§6): a core Plugin and the only bridge between store
// actions and MediaBackends. Handlers call backends synchronously, so actions dispatched inside a
// user-gesture callback keep their activation (SPEC §3 rule 3).

import {
  createError,
  isOtterError,
  type OtterError,
  type Plugin,
  type PluginContext,
  type QoeHook,
  type RouteExplanation,
  type Store,
  type StoreSlice,
  type Unsubscribe,
} from '@otter-player/core';
import type { BackendEvents, BackendFactory, BackendKind, MediaBackend, PlaybackSnapshot } from './backend.js';
import { detectCapabilities, type Capabilities, type CapabilityProbeOptions } from './capabilities.js';
import type { CmcdConfig, CmcdDecorator } from './cmcd.js';
import type { Decoder } from './decoder.js';
import type { ThumbnailProvider } from './thumbnails.js';
import type { FormatPlugin } from './format.js';
import { createRetryBudget, createStallWatchdog, resolveRecovery, type RecoveryPolicy } from './recovery.js';
import { createRouter, stepLabel, type RouteDecision, type RoutePolicy, type Router } from './router.js';
import type { LoadOptions, Source } from './source.js';
import { EMPTY_TRACKS, type InbandCues, type TrackList } from './tracks.js';

export interface MediaState extends PlaybackSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly source: Source | null;
  readonly live: boolean;
  /** Seconds behind the live edge. */
  readonly latency: number | null;
  readonly tracks: TrackList;
  /** Requested quality id or `auto`. */
  readonly quality: string;
  /** Quality id actually playing. */
  readonly activeQuality: string | null;
  readonly backend: string | null;
  readonly format: string | null;
  readonly route: RouteExplanation | null;
  /** ManagedMediaSource in use (iPhone / preferManagedMediaSource). */
  readonly mms: boolean;
  readonly remotePlayback: 'enabled' | 'disabled' | null;
  readonly error: OtterError | null;
}

/**
 * Actions handled by the session. The input-style entries share names and payloads with
 * `InputActionMap` in @otter-player/input (checked by a type test), without a dependency on it.
 */
export interface MediaActionMap {
  load: { readonly source: Source; readonly options?: LoadOptions };
  unload: undefined;
  play: undefined;
  pause: undefined;
  seek: { readonly time: number };
  'set-volume': { readonly volume: number };
  'set-muted': { readonly muted: boolean };
  'set-playback-rate': { readonly rate: number };
  'select-quality': { readonly id: string };
  'toggle-paused': Record<string, never>;
  'seek-by': { readonly seconds: number };
  'seek-to-percent': { readonly percent: number };
  'toggle-muted': Record<string, never>;
  'volume-by': { readonly delta: number };
  /** rate > 0 starts a hold (e.g. long press 2x); rate <= 0 releases and restores the previous rate. */
  'hold-rate': { readonly rate: number };
  /** In-band text track whose cues the engine delivers (used by @otter-player/text), null for none. */
  'set-text-track': { readonly id: string | null };
  'select-audio-track': { readonly id: string };
  /** Live: back to the live edge (the "Back to live" capsule). */
  'seek-to-live': Record<string, never>;
}

const PLAYBACK_RESET: PlaybackSnapshot = {
  paused: true,
  ended: false,
  seeking: false,
  waiting: false,
  currentTime: 0,
  duration: Number.NaN,
  bufferedEnd: 0,
  volume: 1,
  muted: false,
  playbackRate: 1,
  videoWidth: 0,
  videoHeight: 0,
  readyState: 0,
};

export const INITIAL_MEDIA_STATE: MediaState = {
  ...PLAYBACK_RESET,
  status: 'idle',
  source: null,
  live: false,
  latency: null,
  tracks: EMPTY_TRACKS,
  quality: 'auto',
  activeQuality: null,
  backend: null,
  format: null,
  route: null,
  mms: false,
  remotePlayback: null,
  error: null,
};

export const MEDIA_SLICE: StoreSlice<MediaState> = { id: 'media', initialState: INITIAL_MEDIA_STATE };

export interface MediaPluginOptions {
  /** The element backends attach to (VideoSurface element). */
  readonly target: HTMLMediaElement;
  readonly formats: readonly FormatPlugin[];
  readonly backends: readonly BackendFactory[];
  readonly decoders?: readonly Decoder[];
  readonly policy?: RoutePolicy;
  /** Injectable for tests; defaults to the shared detectCapabilities. */
  readonly detect?: (options: CapabilityProbeOptions) => Promise<Capabilities>;
  readonly now?: () => number;
  /** CMCD request data (CTA-5004); off by default (ADR-005 §2). */
  readonly cmcd?: CmcdConfig;
  /** Same-backend retries and stall handling before the fallback chain (ADR-005 §3). */
  readonly recovery?: Partial<RecoveryPolicy>;
}

export interface MediaPlugin<S extends MediaState = MediaState, A extends MediaActionMap = MediaActionMap>
  extends Plugin<S, A> {
  readonly router: Router;
  /** In-band cues of the track chosen with `set-text-track`, for the text renderer. */
  onTextCues(h: (cues: InbandCues) => void): Unsubscribe;
  /** The active engine's seek-preview pictures (I-frame playlist), null without. */
  thumbnails(): ThumbnailProvider | null;
}

interface Active {
  readonly backend: MediaBackend;
  readonly decision: RouteDecision;
  readonly offs: readonly Unsubscribe[];
  readonly loadToken: number;
}

const toError = (err: unknown, details: string): OtterError =>
  isOtterError(err)
    ? err
    : createError({ type: 'media', details, fatal: true, recoverable: false, message: String(err), cause: err });

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export function createMediaPlugin<S extends MediaState = MediaState, A extends MediaActionMap = MediaActionMap>(
  options: MediaPluginOptions,
): MediaPlugin<S, A> {
  const factories = new Map<BackendKind, BackendFactory>(options.backends.map((f) => [f.kind, f]));
  const router = createRouter({
    formats: options.formats,
    backends: [...factories.keys()],
    ...(options.decoders === undefined ? {} : { decoders: options.decoders }),
  });
  const detect = options.detect ?? detectCapabilities;
  const now = options.now ?? (() => performance.now());
  const recovery = resolveRecovery(options.recovery);
  const budget = createRetryBudget(recovery);
  const watchdog = createStallWatchdog(recovery);
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  let store: Store<S, A> | undefined;
  let qoe: QoeHook | undefined;
  let handlerOffs: Unsubscribe[] = [];
  let active: Active | undefined;
  let token = 0;
  // QoE bookkeeping, reset per load.
  let loadStartedAt = 0;
  let firstSegmentAt: number | undefined;
  let rebufferStart: { at: number; position: number } | undefined;
  let watched = 0;
  let lastTime = 0;
  let heldRate: number | undefined;
  // CMCD state not otherwise kept in the store.
  let lastThroughput = Number.NaN;
  let starvedSinceRequest = false;
  let firstFrameSeen = false;
  let cmcd: CmcdDecorator | undefined;
  // In-band text: survives backend rebuilds and fallbacks within a load.
  let textTrack: string | null = null;
  const cueListeners = new Set<(cues: InbandCues) => void>();

  const state = (): Readonly<MediaState> => (store as Store<S, A>).getState();
  const set = (patch: Partial<MediaState>): void => store?.setState(patch as Partial<S>);

  const publishRoute = (explanation: RouteExplanation | null): void => {
    if (explanation === null) return;
    set({ route: explanation });
    qoe?.emit('route', explanation);
  };

  const teardown = (): void => {
    const current = active;
    active = undefined;
    if (stallTimer !== undefined) clearInterval(stallTimer);
    stallTimer = undefined;
    watchdog.reset();
    if (current === undefined) return;
    for (const off of current.offs) off();
    current.backend.destroy();
  };

  const emitExit = (): void => {
    if (state().source === null) return;
    qoe?.emit('exit', { position: state().currentTime, watched });
  };

  const onPlaybackChange = (patch: Partial<PlaybackSnapshot>): void => {
    const s = state();
    if (patch.currentTime !== undefined) {
      const delta = patch.currentTime - lastTime;
      if (!s.paused && !s.seeking && delta > 0 && delta < 2) {
        watched += delta;
        budget.healthy(now());
      }
      lastTime = patch.currentTime;
    }
    // Before the first frame a wait is startup time (TTFF), not a rebuffer; engines that resolve
    // load() after the first append (readyState 1) would otherwise count one on every start.
    if (patch.waiting === true && !s.waiting && !s.seeking && s.readyState > 0 && firstFrameSeen && rebufferStart === undefined) {
      rebufferStart = { at: now(), position: s.currentTime };
      starvedSinceRequest = true;
    }
    if (patch.waiting === false && rebufferStart !== undefined) {
      const endedAt = now();
      qoe?.emit('rebuffer', {
        position: rebufferStart.position,
        startedAt: rebufferStart.at,
        endedAt,
        duration: endedAt - rebufferStart.at,
      });
      rebufferStart = undefined;
    }
    const live =
      patch.duration !== undefined && s.source?.live === undefined
        ? { live: patch.duration === Number.POSITIVE_INFINITY }
        : {};
    set({ ...patch, ...live });
  };

  const wire = (backend: MediaBackend, decision: RouteDecision, loadToken: number): Unsubscribe[] => {
    const current = (): boolean => loadToken === token;
    const on = <E extends keyof BackendEvents>(e: E, h: (p: BackendEvents[E]) => void): Unsubscribe =>
      backend.on(e, (p) => {
        if (current()) h(p);
      });
    return [
      on('playback-change', onPlaybackChange),
      on('tracks-change', (tracks) => {
        // Engines do not always announce the initial rendition; take it from the track list.
        const initial = state().activeQuality === null ? tracks.video.find((v) => v.selected)?.id : undefined;
        set(initial === undefined ? { tracks } : { tracks, activeQuality: initial });
      }),
      on('quality-change', ({ id, auto, reason }) => {
        const from = state().activeQuality;
        set({ activeQuality: id });
        // The initial selection is not a switch.
        if (from !== null && from !== id) qoe?.emit('quality-switch', { from, to: id, reason, mode: auto ? 'auto' : 'manual' });
      }),
      on('latency-change', ({ latency, target }) => {
        set({ latency });
        qoe?.emit('latency', target === undefined ? { latency } : { latency, target });
      }),
      on('first-segment', ({ at }) => {
        firstSegmentAt ??= at;
      }),
      on('first-frame', ({ at }) => {
        firstFrameSeen = true;
        const video = state().tracks.video.find((t) => t.id === state().activeQuality);
        qoe?.emit('startup', {
          ttff: at - loadStartedAt,
          ...(firstSegmentAt === undefined ? {} : { firstSegmentMs: firstSegmentAt - loadStartedAt }),
          backend: stepLabel(decision.step),
          format: decision.format.id,
          ...(video?.codec === undefined ? {} : { codec: video.codec }),
        });
      }),
      on('route-detail', ({ reason, candidate, outcome }) => {
        const label = candidate ?? stepLabel(decision.step);
        const switched = outcome === 'selected' && candidate !== undefined && candidate !== state().backend;
        router.annotate({ candidate: label, outcome: outcome ?? 'selected', reason }, switched ? label : undefined);
        if (switched) set({ backend: label });
        publishRoute(router.explain());
      }),
      on('remote-playback', ({ mms, remotePlayback, reason }) => {
        set({ mms, remotePlayback });
        router.annotate({ candidate: stepLabel(decision.step), outcome: 'selected', reason });
        publishRoute(router.explain());
      }),
      on('bandwidth', (bw) => {
        lastThroughput = bw.estimate;
        qoe?.emit('bandwidth', bw);
      }),
      on('dropped-frames', (df) => qoe?.emit('dropped-frames', df)),
      on('text-cues', (c) => {
        for (const h of cueListeners) h(c);
      }),
      on('error', (error) => {
        if (error.fatal) {
          void recover(decision, error, loadToken);
        } else {
          qoe?.emit('error', { error, fallback: decision.remaining.map(stepLabel) });
        }
      }),
    ];
  };

  /** Runs one routing decision. Resolves null on success, the error otherwise. */
  const attempt = async (decision: RouteDecision, source: Source, opts: LoadOptions, caps: Capabilities, loadToken: number): Promise<OtterError | null> => {
    const factory = factories.get(decision.step.backend);
    if (factory === undefined) return toError(new Error(`no factory for ${decision.step.backend}`), 'backendMissing');
    let backend: MediaBackend;
    try {
      backend = factory.create({
        format: decision.format,
        step: decision.step,
        caps,
        qoe: qoe as QoeHook,
        ...(cmcd === undefined ? {} : { cmcd }),
        ...(options.decoders === undefined ? {} : { decoders: options.decoders }),
      });
    } catch (err) {
      return toError(err, 'backendCreateFailed');
    }
    active = { backend, decision, offs: wire(backend, decision, loadToken), loadToken };
    set({ backend: stepLabel(decision.step), format: decision.format.id });
    try {
      backend.attach(options.target);
      // User preferences go to the element before loading: element events during load (e.g.
      // loadedmetadata) mirror the element into the store, and muted autoplay needs the mute
      // in place before the first play().
      const prefs = state();
      backend.setVolume(prefs.volume);
      backend.setMuted(prefs.muted);
      backend.setPlaybackRate(prefs.playbackRate);
      await backend.load(source, opts);
      if (loadToken !== token) return null;
      if (prefs.quality !== 'auto') backend.selectQuality(prefs.quality);
      if (textTrack !== null) backend.selectTextTrack?.(textTrack);
      set({ status: 'ready', tracks: backend.tracks, error: null });
      watchStalls();
      if (opts.autoplay === true) play();
      return null;
    } catch (err) {
      if (loadToken === token) teardown();
      return toError(err, 'backendLoadFailed');
    }
  };

  /** Walks the fallback chain from `decision` until something loads or the chain is exhausted. */
  const run = async (decision: RouteDecision | null, source: Source, opts: LoadOptions, caps: Capabilities, loadToken: number): Promise<void> => {
    let current = decision;
    while (current !== null) {
      const error = await attempt(current, source, opts, caps, loadToken);
      if (loadToken !== token || error === null) return;
      // Load failures fall back at once (ADR-003) unless the network is to blame.
      if (error.type === 'network' && (await retrySame(current, error, loadToken))) continue;
      if (loadToken !== token) return;
      const next = router.fallback(current, error.details);
      qoe?.emit('error', { error, fallback: next === null ? [] : [stepLabel(next.step), ...next.remaining.map(stepLabel)] });
      publishRoute(router.explain());
      if (next === null) {
        set({ status: 'error', error });
        return;
      }
      current = next;
    }
  };

  let lastCaps: Capabilities | undefined;
  let lastOptions: LoadOptions = {};

  /**
   * Waits out the retry backoff for rebuilding the same step. Resolves false when the budget for
   * this error type is spent (or the load was superseded) and the fallback chain takes over.
   */
  const retrySame = (decision: RouteDecision, error: OtterError, loadToken: number): Promise<boolean> => {
    const delay = budget.next(error, now());
    if (delay === null) return Promise.resolve(false);
    const label = stepLabel(decision.step);
    router.annotate({ candidate: label, outcome: 'failed', reason: `${error.details}, retry in ${delay} ms` });
    qoe?.emit('error', { error, fallback: [label, ...decision.remaining.map(stepLabel)] });
    publishRoute(router.explain());
    return new Promise((resolve) => {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        resolve(loadToken === token);
      }, delay);
    });
  };

  const recover = async (decision: RouteDecision, error: OtterError, loadToken: number): Promise<void> => {
    const source = state().source;
    if (loadToken !== token || source === null || lastCaps === undefined) return;
    const resumeAt = state().currentTime;
    const autoplay = !state().paused;
    teardown();
    set({ status: 'loading' });
    if (await retrySame(decision, error, loadToken)) {
      await run(decision, source, { ...lastOptions, startTime: resumeAt, autoplay }, lastCaps, loadToken);
      return;
    }
    if (loadToken !== token) return;
    const next = router.fallback(decision, error.details);
    qoe?.emit('error', { error, fallback: next === null ? [] : [stepLabel(next.step), ...next.remaining.map(stepLabel)] });
    publishRoute(router.explain());
    if (next === null) {
      set({ status: 'error', error });
      return;
    }
    await run(next, source, { ...lastOptions, startTime: resumeAt, autoplay }, lastCaps, loadToken);
  };

  /**
   * Stall watchdog (ADR-005 §3): playing with media buffered ahead but a frozen playhead. First
   * nudge past the spot, then treat it as a fatal media error (retry, then fallback).
   */
  const watchStalls = (): void => {
    const current = active;
    if (current === undefined || recovery.stallTimeoutMs <= 0) return;
    watchdog.reset();
    stallTimer = setInterval(() => {
      if (active !== current) return;
      const s = state();
      const action = watchdog.sample({
        now: now(),
        currentTime: s.currentTime,
        playing: !s.paused && !s.ended && !s.seeking,
        bufferAhead: s.bufferedEnd - s.currentTime,
      });
      if (action === 'none') return;
      const fatal = action === 'escalate';
      const error = createError({ type: 'media', details: 'playbackStalled', fatal, recoverable: true, message: `playhead stuck at ${s.currentTime}` });
      if (fatal) {
        void recover(current.decision, error, current.loadToken);
        return;
      }
      qoe?.emit('error', { error, fallback: [stepLabel(current.decision.step), ...current.decision.remaining.map(stepLabel)] });
      current.backend.seek(s.currentTime + recovery.nudgeS);
    }, Math.min(1000, recovery.stallTimeoutMs));
  };

  /** Read at request time by CMCD; `bs` is reported once per rebuffer. */
  const cmcdState = () => {
    const s = state();
    const starved = starvedSinceRequest;
    starvedSinceRequest = false;
    const top = s.tracks.video.reduce((m, v) => Math.max(m, v.bitrate ?? 0), 0);
    return {
      format: s.format,
      live: s.live,
      lowLatency: s.live && s.latency !== null && s.latency < 5,
      bufferS: Math.max(0, s.bufferedEnd - s.currentTime),
      throughputBps: lastThroughput,
      topBitrateBps: top > 0 ? top : Number.NaN,
      playbackRate: s.playbackRate,
      startup: !firstFrameSeen,
      starved,
    };
  };

  const load = async (source: Source, opts: LoadOptions): Promise<void> => {
    emitExit();
    teardown();
    const loadToken = ++token;
    loadStartedAt = now();
    firstSegmentAt = undefined;
    rebufferStart = undefined;
    watched = 0;
    lastTime = opts.startTime ?? 0;
    lastOptions = opts;
    textTrack = null;
    budget.reset();
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    const { volume, muted, playbackRate } = state();
    set({
      ...INITIAL_MEDIA_STATE,
      volume,
      muted,
      playbackRate,
      status: 'loading',
      source,
      live: source.live ?? false,
    });
    let caps: Capabilities;
    try {
      caps = await detect({
        ...(source.codecs === undefined ? {} : { codecs: codecProbes(source) }),
        ...(source.drm === undefined ? {} : { keySystems: keySystemsOf(source) }),
      });
    } catch (err) {
      if (loadToken === token) set({ status: 'error', error: toError(err, 'capabilityDetectionFailed') });
      return;
    }
    if (loadToken !== token) return;
    lastCaps = caps;
    firstFrameSeen = false;
    starvedSinceRequest = false;
    lastThroughput = Number.NaN;
    cmcd = undefined;
    if (options.cmcd?.enabled === true) {
      try {
        // Key derivation and encoder load on demand (ADR-004 §2): CMCD is opt-in telemetry.
        const { createCmcdDecorator } = await import('./cmcd.js');
        cmcd = await createCmcdDecorator(options.cmcd, cmcdState);
      } catch (err) {
        // CMCD is telemetry: report and play on without it.
        qoe?.emit('error', {
          error: createError({ type: 'other', details: 'cmcdUnavailable', fatal: false, recoverable: false, message: String(err), cause: err }),
          fallback: [],
        });
      }
      if (loadToken !== token) return;
    }
    let decision: RouteDecision;
    try {
      decision = router.select(source, caps, options.policy);
    } catch (err) {
      publishRoute(router.explain());
      const error = toError(err, 'noRoute');
      qoe?.emit('error', { error, fallback: [] });
      set({ status: 'error', error });
      return;
    }
    publishRoute(decision.explanation);
    await run(decision, source, opts, caps, loadToken);
  };

  const unload = (): void => {
    emitExit();
    teardown();
    token++;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    const { volume, muted, playbackRate } = state();
    set({ ...INITIAL_MEDIA_STATE, volume, muted, playbackRate });
  };

  const play = (): void => {
    const backend = active?.backend;
    if (backend === undefined) return;
    const playToken = token;
    backend.play().catch((err: unknown) => {
      const name = (err as { name?: unknown } | null)?.name;
      // AbortError: a later pause / load / teardown interrupted play(); that event is the story.
      if (name === 'AbortError' || playToken !== token || active?.backend !== backend) return;
      if (state().error?.fatal === true) return;
      const error = createError({
        type: 'media',
        details: name === 'NotAllowedError' ? 'playNotAllowed' : 'playFailed',
        fatal: false,
        recoverable: true,
        message: String(err),
        cause: err,
      });
      set({ error });
      qoe?.emit('error', { error, fallback: [] });
    });
  };

  const seek = (time: number): void => {
    const { duration } = state();
    const max = Number.isFinite(duration) ? duration : Number.POSITIVE_INFINITY;
    active?.backend.seek(clamp(time, 0, max));
  };
  const setVolume = (volume: number): void => {
    active?.backend.setVolume(clamp(volume, 0, 1));
    set({ volume: clamp(volume, 0, 1) });
  };
  const setMuted = (muted: boolean): void => {
    active?.backend.setMuted(muted);
    set({ muted });
  };
  const setRate = (rate: number): void => {
    active?.backend.setPlaybackRate(rate);
    set({ playbackRate: rate });
  };

  return {
    id: 'media',
    router,
    onTextCues(h) {
      cueListeners.add(h);
      return () => cueListeners.delete(h);
    },
    thumbnails: () => active?.backend.thumbnails?.() ?? null,
    install(ctx: PluginContext<S, A>) {
      store = ctx.store;
      qoe = ctx.qoe;
      // Cast: the plugin is generic over any store that contains MediaState / MediaActionMap.
      const s = ctx.store as unknown as Store<MediaState, MediaActionMap>;
      handlerOffs = [
        s.handle('load', ({ source, options: o }) => void load(source, o ?? {})),
        s.handle('unload', unload),
        s.handle('play', play),
        s.handle('pause', () => active?.backend.pause()),
        s.handle('seek', ({ time }) => seek(time)),
        s.handle('set-volume', ({ volume }) => setVolume(volume)),
        s.handle('set-muted', ({ muted }) => setMuted(muted)),
        s.handle('set-playback-rate', ({ rate }) => setRate(rate)),
        s.handle('select-quality', ({ id }) => {
          active?.backend.selectQuality(id);
          set({ quality: id });
        }),
        s.handle('toggle-paused', () => (state().paused ? play() : active?.backend.pause())),
        s.handle('seek-by', ({ seconds }) => seek(state().currentTime + seconds)),
        s.handle('seek-to-percent', ({ percent }) => {
          const { duration } = state();
          if (Number.isFinite(duration)) seek((duration * clamp(percent, 0, 100)) / 100);
        }),
        s.handle('toggle-muted', () => setMuted(!state().muted)),
        s.handle('volume-by', ({ delta }) => setVolume(state().volume + delta)),
        s.handle('select-audio-track', ({ id }) => active?.backend.selectAudioTrack?.(id)),
        s.handle('seek-to-live', () => active?.backend.seekToLive?.()),
        s.handle('set-text-track', ({ id }) => {
          textTrack = id;
          active?.backend.selectTextTrack?.(id);
        }),
        s.handle('hold-rate', ({ rate }) => {
          if (rate > 0) {
            heldRate ??= state().playbackRate;
            setRate(rate);
          } else if (heldRate !== undefined) {
            setRate(heldRate);
            heldRate = undefined;
          }
        }),
      ];
    },
    uninstall() {
      unload();
      for (const off of handlerOffs) off();
      handlerOffs = [];
      store = undefined;
      qoe = undefined;
    },
  };
}

/** Key systems to probe: every configured license server, plus ClearKey when keys are inline. */
function keySystemsOf(source: Source): string[] {
  const drm = source.drm;
  if (drm === undefined) return [];
  const systems = new Set(Object.keys(drm.servers));
  if (drm.clearKeys !== undefined && Object.keys(drm.clearKeys).length > 0) systems.add('org.w3.clearkey');
  return [...systems];
}

/** MIME + codecs strings for the hinted codecs, so the router can see e.g. HEVC support before loading. */
function codecProbes(source: Source): string[] {
  const mime = source.type?.startsWith('video/') === true || source.type?.startsWith('audio/') === true ? source.type : 'video/mp4';
  return (source.codecs ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '')
    .map((c) => `${/^(mp4a|opus|ac-3|ec-3|flac)/.test(c) ? mime.replace(/^video\//, 'audio/') : mime}; codecs="${c}"`);
}
