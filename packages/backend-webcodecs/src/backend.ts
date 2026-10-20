// WebCodecs backend (SPEC §6.3, ADR-008 §2): Demuxer -> Decoder -> frame queue -> FrameSurface,
// audio through an AudioWorklet. Media time is the master clock (clock.ts); each render tick shows
// the latest frame whose timestamp is at or before it and drops the ones it skipped. A seek decodes
// from the keyframe at or before the target, discards everything earlier than the frame that
// covers the target, and shows that frame (frame accurate, like <video>).
//
// Decoders are plugins (BackendContext.decoders): the WebCodecs one now, the WASM one next. Frames
// arrive through DecoderConfig.output as transferable objects, so moving decoding into a Worker
// pool changes where the Decoder runs, not this file.

import { createError, createEventBus, isOtterError, type OtterError, type Unsubscribe } from '@otter-player/core';
import {
  closeFrame,
  EMPTY_TIME_RANGES,
  EMPTY_TRACKS,
  isI420,
  type BackendContext,
  type BackendEvents,
  type DecodedFrame,
  type Decoder,
  type DecoderInstance,
  type Demuxer,
  type DemuxInfo,
  type EncodedChunk,
  type FrameSink,
  type I420Frame,
  type MediaBackend,
  type PacketStream,
  type PlaybackSnapshot,
  type TrackList,
} from '@otter-player/media';
import { createAudioSink, type AudioSink } from './audio.js';
import { acquireAudioContext, createClock, releaseAudioContext, setPlaying, type MediaClock } from './clock.js';

export interface WebCodecsBackendOptions {
  /** Upper bound on concurrently decoding instances sharing the Worker pool (SPEC §6.3). */
  readonly maxConcurrentDecoders?: number;
  /**
   * Where pictures go: a FrameSurface from @otter-player/surface/gpu (GPUSurface, else
   * CanvasSurface), or anything with draw / clear. Owned by the host: cleared, not destroyed,
   * with the backend.
   */
  readonly sink: FrameSink;
}

/** A frame counts as "at or before t" up to this much after t (µs), against rounding. */
const EPS_US = 500;
/** Decoded frames (queued + in the decoder) kept ahead of the clock. */
const VIDEO_AHEAD = 8;
/** Seconds of audio handed to the worklet ahead of the clock. */
const AUDIO_AHEAD_S = 1;
/** Frames queued before playback resumes after running dry. */
const RESUME_FRAMES = 3;
const TIME_UPDATE_MS = 250;
/** Playing this long without the AudioContext clock is reported (audioClockUnavailable). */
const PERF_REPORT_MS = 1000;

const fatal = (type: OtterError['type'], details: string, message: string, cause?: unknown): OtterError & Error =>
  createError({ type, details, fatal: true, recoverable: false, message, ...(cause === undefined ? {} : { cause }) });

const timeRanges = (start: number, end: number): TimeRanges => {
  if (!(end > start)) return EMPTY_TIME_RANGES;
  const at = (i: number, v: number): number => {
    if (i !== 0) throw new DOMException(`index ${i} out of range`, 'IndexSizeError');
    return v;
  };
  return { length: 1, start: (i) => at(i, start), end: (i) => at(i, end) };
};

const frameTime = (f: DecodedFrame): number => (isI420(f) ? f.timestamp : (f as VideoFrame).timestamp);

/** Wakes waiting pumps: on decoder output, render ticks, seeks, teardown; at the latest after `ms`. */
function createSignal() {
  let waiters: (() => void)[] = [];
  return {
    wait: (ms = 20): Promise<void> =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, ms);
      }),
    notify(): void {
      const w = waiters;
      waiters = [];
      for (const r of w) r();
    },
  };
}

const schedule = (cb: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
};

export function createWebCodecsBackend(ctx: BackendContext, options: WebCodecsBackendOptions): MediaBackend {
  const bus = createEventBus<BackendEvents>();
  const abort = new AbortController();
  /** This instance, as a player of the shared AudioContext. */
  const owner = {};
  const signal = createSignal();
  let destroyed = false;
  const sinkOut = options.sink;
  let demuxer: Demuxer | undefined;
  let info: DemuxInfo | undefined;
  let tracks: TrackList = EMPTY_TRACKS;
  let buffered: TimeRanges = EMPTY_TIME_RANGES;
  let audioCtx: AudioContext | undefined;
  let clock: MediaClock | undefined;
  let sink: AudioSink | undefined;
  let video: DecoderInstance | undefined;
  let audio: DecoderInstance | undefined;
  let volume = 1;
  let muted = false;
  let rate = 1;

  // Playback state.
  const snap: { -readonly [K in keyof PlaybackSnapshot]: PlaybackSnapshot[K] } = {
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
  const update = (patch: Partial<PlaybackSnapshot>): void => {
    const changed: Partial<PlaybackSnapshot> = {};
    for (const [k, v] of Object.entries(patch) as [keyof PlaybackSnapshot, never][]) {
      if (!Object.is(snap[k], v)) {
        (snap as Record<string, unknown>)[k] = v;
        (changed as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(changed).length > 0) bus.emit('playback-change', changed);
    // The shared AudioContext idles (suspends) while no instance plays.
    if (changed.paused !== undefined) setPlaying(audioCtx, owner, !changed.paused);
  };

  // Decoding state. `gen` changes on every seek; work of an older generation stops.
  let gen = 0;
  const queue: DecodedFrame[] = [];
  let videoEos = false;
  let audioEos = false;
  let seek: { target: number; candidate: DecodedFrame | undefined; resume: boolean } | undefined;
  let shownAt = Number.NEGATIVE_INFINITY;
  let firstFrame = false;
  let dropped = 0;
  let total = 0;
  let lastTimeUpdate = 0;
  let cancelTick: (() => void) | undefined;
  let loaded: { resolve: () => void; reject: (e: unknown) => void } | undefined;
  // Playing on performance.now() instead of the AudioContext (QoE once, after PERF_REPORT_MS).
  let sourceReason = '';
  let perfSince: number | undefined;
  let perfReported = false;

  const fail = (error: OtterError): void => {
    if (destroyed) return;
    if (loaded !== undefined) {
      loaded.reject(error);
      loaded = undefined;
      return;
    }
    bus.emit('error', error);
  };

  const show = (frame: DecodedFrame): void => {
    shownAt = frameTime(frame);
    total++;
    sinkOut.draw(frame as VideoFrame | I420Frame);
    if (!firstFrame) {
      firstFrame = true;
      bus.emit('first-frame', { at: performance.now() });
    }
  };

  const finishSeek = (frame: DecodedFrame | undefined): void => {
    const s = seek;
    if (s === undefined) return;
    seek = undefined;
    if (frame !== undefined) show(frame);
    update({ seeking: false, readyState: 4, currentTime: s.target });
    bus.emit('playback-change', { currentTime: s.target });
    loaded?.resolve();
    loaded = undefined;
    if (s.resume && clock !== undefined) {
      clock.start();
      update({ paused: false });
    }
  };

  const onVideoFrame = (frame: DecodedFrame): void => {
    if (destroyed) return closeFrame(frame);
    signal.notify();
    const s = seek;
    if (s === undefined) {
      queue.push(frame);
      return;
    }
    // Seeking: keep the latest frame at or before the target; the first later one ends the seek.
    if (frameTime(frame) <= s.target * 1e6 + EPS_US) {
      closeFrame(s.candidate);
      s.candidate = frame;
      return;
    }
    if (s.candidate === undefined) {
      finishSeek(frame);
    } else {
      finishSeek(s.candidate);
      queue.push(frame);
    }
  };

  const onAudioData = (data: DecodedFrame): void => {
    if (destroyed || sink === undefined || isI420(data)) return closeFrame(data);
    sink.push(data as AudioData);
    signal.notify();
  };

  const ahead = (track: 'video' | 'audio'): boolean => {
    if (track === 'video') return queue.length + (video?.decodeQueueSize ?? 0) >= VIDEO_AHEAD;
    if (sink === undefined || clock === undefined) return false;
    return (audio?.decodeQueueSize ?? 0) > 16 || sink.bufferedEnd - clock.now() > AUDIO_AHEAD_S;
  };

  /** Feeds one track from `stream` until it ends or a newer generation takes over. */
  const pump = async (track: 'video' | 'audio', stream: PacketStream, g: number): Promise<void> => {
    const decoder = track === 'video' ? video : audio;
    if (decoder === undefined) return;
    const it = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next: IteratorResult<EncodedChunk> = await it.next();
        if (g !== gen || destroyed) return;
        if (next.done === true) break;
        while (ahead(track) && g === gen && !destroyed) await signal.wait();
        if (g !== gen || destroyed) return;
        decoder.decode(next.value);
      }
      // Frames still held for reordering come out on flush.
      await decoder.flush().catch(() => undefined);
      if (g !== gen || destroyed) return;
      if (track === 'video') {
        videoEos = true;
        if (seek !== undefined) finishSeek(seek.candidate);
      } else {
        audioEos = true;
      }
    } catch (err) {
      if (g === gen) fail(isOtterError(err) ? err : fatal('mux', 'demuxFailed', String(err), err));
    } finally {
      if (g !== gen || destroyed) void it.return?.();
    }
  };

  const startSeek = (time: number, resume: boolean): void => {
    if (demuxer === undefined || info === undefined) return;
    const d = demuxer;
    const g = ++gen;
    signal.notify();
    if (seek !== undefined) closeFrame(seek.candidate);
    for (const f of queue.splice(0)) closeFrame(f);
    video?.reset();
    audio?.reset();
    sink?.flush();
    videoEos = info.video === null;
    audioEos = info.audio === null || audio === undefined;
    const target = Math.min(Math.max(time, 0), info.duration);
    clock?.stop();
    clock?.set(target);
    seek = { target, candidate: undefined, resume };
    update({ seeking: true, ended: false, waiting: false, currentTime: target, paused: !resume });
    if (info.video !== null) void d.seek('video', target).then((s) => (g === gen ? pump('video', s, g) : undefined), (e: unknown) => fail(fatal('mux', 'demuxFailed', String(e), e)));
    else finishSeek(undefined);
    if (audio !== undefined) void d.seek('audio', target).then((s) => (g === gen ? pump('audio', s, g) : undefined), (e: unknown) => fail(fatal('mux', 'demuxFailed', String(e), e)));
  };

  const tick = (): void => {
    cancelTick = undefined;
    if (destroyed || clock === undefined || info === undefined) return;
    clock.check();
    const playing = clock.playing;
    // Before a gesture the context is suspended by autoplay policy; that only matters (and is
    // reported) when playback keeps running without it.
    if (playing && clock.source === 'performance' && !perfReported) {
      perfSince ??= performance.now();
      if (performance.now() - perfSince > PERF_REPORT_MS) {
        perfReported = true;
        bus.emit('error', createError({ type: 'media', details: 'audioClockUnavailable', fatal: false, recoverable: true, message: `clock on performance.now(): ${sourceReason}` }));
      }
    } else if (clock.source === 'audio') {
      perfSince = undefined;
    }
    const t = clock.now();
    if (seek === undefined) {
      // The latest frame at or before the clock; the ones before it were skipped (dropped).
      let latest: DecodedFrame | undefined;
      while (queue.length > 0 && frameTime(queue[0] as DecodedFrame) <= t * 1e6 + EPS_US) {
        if (latest !== undefined) {
          closeFrame(latest);
          dropped++;
          total++;
        }
        latest = queue.shift();
      }
      if (latest !== undefined) {
        show(latest);
        signal.notify();
      }
      const frameUs = 1e6 / (info.video?.frameRate ?? 30);
      if (playing && info.video !== null && !videoEos && queue.length === 0 && t * 1e6 > shownAt + 2 * frameUs) {
        // Ran dry: hold the clock until a few frames are decoded.
        clock.stop();
        update({ waiting: true, currentTime: clock.now() });
        bus.emit('waiting', { position: clock.now() });
      } else if (snap.waiting && (queue.length >= RESUME_FRAMES || videoEos)) {
        clock.start();
        update({ waiting: false });
      }
      if ((playing || snap.waiting) && videoEos && audioEos && queue.length === 0 && t >= info.duration - 1e-3) {
        clock.stop();
        clock.set(info.duration);
        update({ currentTime: info.duration, paused: true, ended: true, waiting: false });
        bus.emit('ended', { position: info.duration });
      }
      const nowMs = performance.now();
      if (playing && nowMs - lastTimeUpdate >= TIME_UPDATE_MS) {
        lastTimeUpdate = nowMs;
        update({ currentTime: Math.min(t, info.duration) });
        if (dropped > 0) bus.emit('dropped-frames', { dropped, total });
      }
    }
    cancelTick = schedule(tick);
  };

  const pickDecoder = (kind: 'video' | 'audio'): Decoder | undefined => {
    const all = ctx.decoders ?? [];
    // Audio always decodes with WebCodecs when available; video follows the route step.
    if (kind === 'audio' || ctx.step.decoder !== 'wasm') return all.find((d) => d.id === 'webcodecs');
    return all.find((d) => d.id.startsWith('wasm'));
  };

  const backend: MediaBackend = {
    kind: 'webcodecs',
    get tracks() {
      return tracks;
    },
    get buffered() {
      return buffered;
    },
    // Pictures go to the sink; the element (for PiP through captureStream, later) is not used yet.
    attach: () => undefined,
    async load(source, opts) {
      if (ctx.format.createDemuxer === undefined) throw fatal('other', 'noDemuxer', `format ${ctx.format.id} cannot feed WebCodecs`);
      demuxer = await ctx.format.createDemuxer({ source, options: opts, caps: ctx.caps, qoe: ctx.qoe, signal: abort.signal });
      if (destroyed) return demuxer.destroy();
      info = demuxer.info;
      const v = info.video;
      const a = info.audio;

      if (v !== null) {
        const decoder = pickDecoder('video');
        if (decoder === undefined) throw fatal('media', 'noDecoder', `no ${ctx.step.decoder ?? 'webcodecs'} decoder registered`);
        const support = await decoder.supports(v.codec, ctx.caps);
        if (support === false) throw fatal('media', 'codecUnsupported', `${decoder.id} cannot decode ${v.codec}`);
        bus.emit('route-detail', { reason: `${v.codec} on ${decoder.id} (${support})${decoder.describe === undefined ? '' : `: ${decoder.describe()}`}` });
        video = decoder.create({ ...v.setup, output: onVideoFrame, error: fail });
      }
      if (a !== null) {
        const decoder = pickDecoder('audio');
        const support = decoder === undefined ? false : await decoder.supports(a.codec, ctx.caps);
        audioCtx = acquireAudioContext();
        if (decoder !== undefined && support !== false && audioCtx !== undefined) {
          try {
            sink = await createAudioSink(audioCtx);
            sink.setVolume(volume, muted);
            audio = decoder.create({ ...a.setup, output: onAudioData, error: fail });
          } catch (err) {
            // Keep the picture and the clock; say why there is no sound.
            bus.emit('error', createError({ type: 'media', details: 'audioOutputUnavailable', fatal: false, recoverable: true, message: String(err), cause: err }));
          }
        } else {
          // Play the picture without sound rather than fall back.
          bus.emit('error', createError({ type: 'media', details: 'audioUnsupported', fatal: false, recoverable: false, message: `no decoder for audio ${a.codec}` }));
        }
      }
      audioCtx ??= acquireAudioContext();
      clock = createClock(audioCtx);
      clock.setRate(rate);
      if (sink !== undefined) {
        const s = sink;
        clock.onAnchor((anchor) => s.setAnchor(anchor));
      }
      clock.onSource((_source, reason) => {
        sourceReason = reason;
      });
      sourceReason = `AudioContext ${audioCtx?.state ?? 'unavailable'}`;
      if (destroyed) return;

      tracks = {
        video: v === null ? [] : [{ id: String(v.id), kind: 'video', codec: v.codec, width: v.width, height: v.height, ...(v.frameRate === undefined ? {} : { frameRate: v.frameRate }), selected: true }],
        audio: a === null ? [] : [{ id: String(a.id), kind: 'audio', codec: a.codec, channels: a.channels, selected: true }],
        text: [],
        quality: 'selectable',
        requestedQuality: 'auto',
      };
      buffered = timeRanges(Math.max(0, info.startTime), info.duration);
      bus.emit('tracks-change', tracks);
      bus.emit('buffered-change', { buffered });
      update({ duration: info.duration, bufferedEnd: info.duration, videoWidth: v?.width ?? 0, videoHeight: v?.height ?? 0, readyState: 1 });
      cancelTick = schedule(tick);
      // Resolves once the first picture is on the surface.
      const first = new Promise<void>((resolve, reject) => {
        loaded = { resolve, reject };
      });
      startSeek(opts.startTime ?? Math.max(0, info.startTime), false);
      await first;
    },
    play() {
      if (clock === undefined || info === undefined) return Promise.resolve();
      if (snap.ended) {
        startSeek(Math.max(0, info.startTime), true);
        return Promise.resolve();
      }
      if (seek !== undefined) {
        seek.resume = true;
        update({ paused: false });
        return Promise.resolve();
      }
      clock.start();
      update({ paused: false, waiting: false });
      return Promise.resolve();
    },
    pause() {
      if (seek !== undefined) seek.resume = false;
      if (clock !== undefined) {
        clock.stop();
        update({ paused: true, waiting: false, currentTime: clock.now() });
      }
    },
    seek(t) {
      startSeek(t, seek?.resume ?? (clock?.playing === true || snap.waiting));
    },
    setVolume(v) {
      volume = v;
      sink?.setVolume(volume, muted);
      update({ volume: v });
    },
    setMuted(m) {
      muted = m;
      sink?.setVolume(volume, muted);
      update({ muted: m });
    },
    setPlaybackRate(r) {
      rate = r;
      clock?.setRate(r);
      update({ playbackRate: r });
    },
    selectQuality: () => undefined,
    on<E extends keyof BackendEvents>(e: E, h: (p: BackendEvents[E]) => void): Unsubscribe {
      return bus.on(e, (p) => h(p));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      gen++;
      abort.abort();
      signal.notify();
      cancelTick?.();
      loaded?.reject(fatal('other', 'destroyed', 'backend destroyed during load'));
      loaded = undefined;
      if (seek !== undefined) closeFrame(seek.candidate);
      seek = undefined;
      for (const f of queue.splice(0)) closeFrame(f);
      video?.close();
      audio?.close();
      sink?.destroy();
      clock?.destroy();
      releaseAudioContext(audioCtx, owner);
      demuxer?.destroy();
      sinkOut.clear();
      bus.clear();
    },
  };
  return backend;
}
