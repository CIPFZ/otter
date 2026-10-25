// Own engine -> adapter fallback (ADR-007 §2, ADR-010 §4). The format rebuilds once with the
// engine adapter (mpegts.js, hls.js):
// - at load, when the own engine fails for a media reason (a codec it does not carry, a demux
//   error) or reports `ownEngineUnsupported` (HLS features it leaves to hls.js);
// - at runtime, on a fatal media error after the start: from the current position, keeping the
//   user's quality (a manual choice stays manual), text and audio track, and the playback speed.
// Network errors do not fall back: the adapter would fail the same way, and the session's retry
// policy (ADR-005 §3) handles them. The switch is reported as a non-fatal `pipelineFallback` whose
// message gives the reason (backend-mse records it in router.explain()).

import { createError, createEventBus, isOtterError, type OtterError, type Unsubscribe } from '@otter-player/core';
import type { BaseTrack, Engine, EngineEvents, TrackList, VideoTrack } from '@otter-player/media';

/** The error's message (OtterErrors are Errors; the model's fields have none). */
const messageOf = (e: OtterError): string | undefined => (e instanceof Error && e.message !== e.details ? e.message : undefined);

const EVENTS = {
  'tracks-change': true,
  'quality-change': true,
  'latency-change': true,
  'first-segment': true,
  bandwidth: true,
  'text-cues': true,
  error: true,
} as const satisfies Record<keyof EngineEvents, true>;

type SeekToLive = { seekToLive?(): void };

export interface AdapterFallbackOptions {
  /** The element both engines play on: position and playing state carry over a runtime switch. */
  readonly media?: HTMLMediaElement;
}

/** The adapter's video track closest to `t` (same height, then nearest bitrate). */
function sameVideo(t: VideoTrack, list: readonly VideoTrack[]): VideoTrack | undefined {
  const pool = list.filter((v) => v.height === t.height);
  const from = pool.length > 0 ? pool : list;
  return [...from].sort((a, b) => Math.abs((a.bitrate ?? 0) - (t.bitrate ?? 0)) - Math.abs((b.bitrate ?? 0) - (t.bitrate ?? 0)))[0];
}

/** Same id, else same language (and role / label where both have one). */
function sameTrack<T extends BaseTrack & { readonly role?: string }>(t: T, list: readonly T[]): T | undefined {
  return list.find((x) => x.id === t.id) ?? list.find((x) => x.language === t.language && (x.role === undefined || x.role === t.role) && (x.label === undefined || t.label === undefined || x.label === t.label)) ?? list.find((x) => x.language === t.language && (x.role === undefined || x.role === t.role));
}

export function withAdapterFallback(
  primary: Engine & SeekToLive,
  createFallback: (startTime?: number) => Engine & SeekToLive,
  options: AdapterFallbackOptions = {},
): Engine & { seekToLive(): void; readonly usingFallback: boolean } {
  const bus = createEventBus<EngineEvents>();
  let current: Engine & SeekToLive = primary;
  let usingFallback = false;
  let loaded = false;
  let forwards: Unsubscribe[] = [];
  // The user's choices, re-applied on the adapter after a runtime switch.
  let quality = 'auto';
  let text: string | null | undefined;
  let audio: string | undefined;

  const fallbackError = (message: string, cause: OtterError): OtterError =>
    createError({ type: 'other', details: 'pipelineFallback', fatal: false, recoverable: true, message, cause });

  const forward = (engine: Engine): void => {
    for (const off of forwards) off();
    forwards = (Object.keys(EVENTS) as (keyof EngineEvents)[]).map((e) =>
      engine.on(e, (p) => {
        if (e === 'error' && engine === primary && loaded && !usingFallback) {
          const err = p as OtterError;
          if (err.fatal && err.type !== 'network') {
            void runtimeFallback(err);
            return;
          }
        }
        bus.emit(e, p as never);
      }),
    );
  };
  forward(primary);

  /** The user's selections on the adapter's tracks (ids differ between engines). */
  const reapply = (before: TrackList): void => {
    const after = current.tracks;
    if (quality !== 'auto') {
      const was = before.video.find((v) => v.id === quality);
      const match = was === undefined ? undefined : sameVideo(was, after.video);
      if (match !== undefined) current.selectQuality(match.id);
    }
    if (text !== undefined) {
      const was = text === null ? undefined : before.text.find((t) => t.id === text);
      current.selectTextTrack?.(text === null ? null : was === undefined ? null : (sameTrack(was, after.text)?.id ?? null));
    }
    if (audio !== undefined) {
      const was = before.audio.find((a) => a.id === audio);
      const match = was === undefined ? undefined : sameTrack(was, after.audio);
      if (match !== undefined) current.selectAudioTrack?.(match.id);
    }
  };

  const runtimeFallback = async (error: OtterError): Promise<void> => {
    const media = options.media;
    const at = media?.currentTime;
    const playing = media !== undefined && !media.paused;
    // The adapter's MediaSource reloads the element, which resets its speed (HTML load algorithm).
    const rate = media?.playbackRate;
    const before = primary.tracks;
    primary.destroy();
    usingFallback = true;
    current = createFallback(at);
    forward(current);
    bus.emit('error', fallbackError(`own engine failed during playback: ${error.details}${messageOf(error) === undefined ? '' : ` (${messageOf(error) as string})`}; using the adapter from ${at === undefined ? 'the start' : `${at.toFixed(1)} s`}`, error));
    try {
      await current.load();
    } catch (err) {
      bus.emit('error', isOtterError(err) ? err : createError({ type: 'media', details: 'adapterLoadFailed', fatal: true, recoverable: false, message: String(err), cause: err }));
      return;
    }
    reapply(before);
    if (media !== undefined && rate !== undefined && media.playbackRate !== rate) media.playbackRate = rate;
    bus.emit('tracks-change', current.tracks);
    if (playing) void media?.play().catch(() => undefined);
  };

  return {
    get formatId() {
      return current.formatId;
    },
    get tracks() {
      return current.tracks;
    },
    get latency() {
      return current.latency;
    },
    get targetLatency() {
      return current.targetLatency;
    },
    get mms() {
      return current.mms;
    },
    get usingFallback() {
      return usingFallback;
    },
    async load() {
      try {
        await primary.load();
        loaded = true;
      } catch (err) {
        const error = isOtterError(err) ? err : undefined;
        if (error === undefined || error.type === 'network' || error.details === 'unsupportedSource') throw err;
        primary.destroy();
        usingFallback = true;
        current = createFallback();
        forward(current);
        const why = error.details === 'ownEngineUnsupported' ? `own engine does not support this stream: ${messageOf(error) ?? 'unsupported'}` : `own pipeline: ${error.details}${err instanceof Error ? ` (${err.message})` : ''}`;
        bus.emit('error', fallbackError(`${why}; using the adapter`, error));
        await current.load();
      }
    },
    selectQuality(id) {
      quality = id;
      current.selectQuality(id);
    },
    // Every optional Engine method goes to whichever engine is active (608 caption selection on
    // the pipeline, audio tracks on the adapter, ...).
    selectTextTrack(id) {
      text = id;
      current.selectTextTrack?.(id);
    },
    selectAudioTrack(id) {
      audio = id;
      current.selectAudioTrack?.(id);
    },
    thumbnails: () => current.thumbnails?.() ?? null,
    seekToLive: () => current.seekToLive?.(),
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      for (const off of forwards) off();
      forwards = [];
      current.destroy();
      bus.clear();
    },
  };
}
