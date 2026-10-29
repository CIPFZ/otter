// MSE / ManagedMediaSource backend (SPEC §6.2, ADR-003 §2/§5). In M1 it hosts engine adapters
// (hls.js / Shaka / mpegts.js own the MediaSource on the element); the serialized buffer queue,
// dual SourceBuffer and quota eviction arrive with the own pipeline in M3.

import { createError, createEventBus, type Unsubscribe } from '@otter-player/core';
import {
  EMPTY_TIME_RANGES,
  EMPTY_TRACKS,
  NO_CODEC_RANKING,
  observeMediaElement,
  seekMedia,
  type BackendContext,
  type BackendEvents,
  type BackendFactory,
  type Engine,
  type MediaBackend,
  type MediaElementObserver,
  type TrackList,
} from '@otter-player/media';
import { airPlayAlternate, finishRemotePlayback, prepareRemotePlayback, useManagedMediaSource } from './mms.js';
import { removeSourceChildren } from './vendor/hls.js/mediasource.js';

export { airPlayAlternate, finishRemotePlayback, prepareRemotePlayback, useManagedMediaSource } from './mms.js';

// 4 / s: the DVR display ("−6.2 s") stays within a quarter second of the edge, also while paused
// (ADR-011 §2: checked against the picture to ±0.5 s).
const LATENCY_SAMPLE_MS = 250;
/** Anything above an hour is a bogus playhead / clock combination, not a latency. */
const MAX_PLAUSIBLE_LATENCY_S = 3600;

export interface MseBackendOptions {
  /** Use ManagedMediaSource when both MMS and MSE exist (SPEC §6.2). Default true, like hls.js. */
  readonly preferManagedMediaSource?: boolean;
  /** Allow cross-codec quality switches via `changeType`; default stays within one codec family. */
  readonly allowCodecSwitch?: boolean;
}

export function createMseBackend(ctx: BackendContext, options: MseBackendOptions = {}): MediaBackend {
  const bus = createEventBus<BackendEvents>();
  const emit = <E extends keyof BackendEvents>(e: E, p: BackendEvents[E]): void => bus.emit(e, p);
  let media: HTMLMediaElement | undefined;
  let observer: MediaElementObserver | undefined;
  let engine: Engine | undefined;
  let added: HTMLSourceElement | undefined;
  const offs: Unsubscribe[] = [];

  const element = (): HTMLMediaElement => {
    if (media === undefined) throw createError({ type: 'other', details: 'backendNotAttached', fatal: true, recoverable: false });
    return media;
  };

  return {
    kind: 'mse',
    get tracks(): TrackList {
      return engine?.tracks ?? EMPTY_TRACKS;
    },
    get buffered() {
      return media?.buffered ?? EMPTY_TIME_RANGES;
    },
    get latency() {
      return engine?.latency;
    },
    attach(target) {
      if (!('canPlayType' in target)) {
        throw createError({ type: 'other', details: 'unsupportedTarget', fatal: true, recoverable: false, message: 'mse backend needs a media element' });
      }
      media = target;
      observer = observeMediaElement(target, emit);
      // Engines report latency at different cadences (or once); sample it uniformly, at most 1/s,
      // and only once a frame is presented so the playhead is meaningful.
      let lastSample = Number.NEGATIVE_INFINITY;
      const sample = (): void => {
        const now = performance.now();
        // Throttle with slack: a timer / timeupdate a hair early must not skip to the next tick.
        if (engine === undefined || target.readyState < 2 || now - lastSample < LATENCY_SAMPLE_MS * 0.8) return;
        const latency = engine.latency;
        if (latency === undefined || !Number.isFinite(latency) || latency < 0 || latency > MAX_PLAUSIBLE_LATENCY_S) return;
        lastSample = now;
        const goal = engine.targetLatency;
        emit('latency-change', goal === undefined ? { latency } : { latency, target: goal });
      };
      // timeupdate stops while paused, and WebKit fires no MSE progress events then: a timer keeps
      // latency current while live data keeps arriving (it drives "Back to live").
      let timer: ReturnType<typeof setInterval> | undefined;
      const paused = (): void => {
        if (timer === undefined) timer = setInterval(sample, LATENCY_SAMPLE_MS);
      };
      const playing = (): void => {
        clearInterval(timer);
        timer = undefined;
      };
      target.addEventListener('timeupdate', sample);
      target.addEventListener('pause', paused);
      target.addEventListener('playing', playing);
      offs.push(() => {
        playing();
        target.removeEventListener('timeupdate', sample);
        target.removeEventListener('pause', paused);
        target.removeEventListener('playing', playing);
      });
    },
    async load(source, opts) {
      const m = element();
      const mms = useManagedMediaSource(options.preferManagedMediaSource ?? true);
      const alternate = airPlayAlternate(source);
      prepareRemotePlayback(m, mms, alternate);

      const e = ctx.format.createEngine({
        source,
        options: opts,
        caps: ctx.caps,
        backend: 'mse',
        qoe: ctx.qoe,
        media: m,
        mms,
        allowCodecSwitch: options.allowCodecSwitch ?? false,
        codecs: ctx.codecs ?? NO_CODEC_RANKING,
        ...(ctx.cmcd === undefined ? {} : { cmcd: ctx.cmcd }),
      });
      engine = e;
      offs.push(
        e.on('tracks-change', (t) => emit('tracks-change', t)),
        e.on('quality-change', (q) => emit('quality-change', q)),
        // Latency is sampled from engine.latency on timeupdate (see attach), not forwarded.
        e.on('first-segment', (f) => emit('first-segment', f)),
        e.on('bandwidth', (b) => emit('bandwidth', b)),
        e.on('text-cues', (c) => emit('text-cues', c)),
        e.on('error', (err) => {
          // Own engine -> adapter, an abandoned segment download (ADR-010 §4): the reason goes into router.explain().
          if (err.details === 'pipelineFallback' || err.details === 'segmentAbandoned') emit('route-detail', { reason: err instanceof Error ? err.message : err.details });
          emit('error', err);
        }),
      );
      await e.load();
      // The engine decides whether it really runs on MMS (Shaka always uses MMS when present).
      const result = finishRemotePlayback(m, e.mms, alternate);
      added = result.added;
      emit('remote-playback', { mms: e.mms, remotePlayback: result.remotePlayback, reason: result.reason });
      emit('tracks-change', e.tracks);
    },
    play: () => element().play(),
    pause: () => element().pause(),
    seek(t) {
      seekMedia(element(), t);
    },
    setVolume(v) {
      element().volume = v;
    },
    setMuted(m) {
      element().muted = m;
    },
    setPlaybackRate(r) {
      element().playbackRate = r;
    },
    selectQuality(id) {
      engine?.selectQuality(id);
    },
    selectTextTrack(id) {
      engine?.selectTextTrack?.(id);
    },
    selectAudioTrack(id) {
      engine?.selectAudioTrack?.(id);
    },
    seekToLive() {
      engine?.seekToLive?.();
    },
    thumbnails: () => engine?.thumbnails?.() ?? null,
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      // Stop observing first: detaching the MediaSource fires element errors we must not report.
      observer?.destroy();
      for (const off of offs.splice(0)) off();
      bus.clear();
      engine?.destroy();
      engine = undefined;
      if (media !== undefined) {
        added?.remove();
        removeSourceChildren(media);
        media.removeAttribute('src');
        media.load();
      }
      added = undefined;
      media = undefined;
    },
  };
}

export function createMseBackendFactory(options: MseBackendOptions = {}): BackendFactory {
  return { kind: 'mse', create: (ctx) => createMseBackend(ctx, options) };
}
