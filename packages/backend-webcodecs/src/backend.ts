// WebCodecs backend (SPEC §6.3, ADR-008 §2): Demuxer -> Decoder -> frame queue -> FrameSink,
// audio through an AudioWorklet. Media time is the master clock (clock.ts); each render tick shows
// the latest frame whose timestamp is at or before it and drops the ones it skipped. A seek decodes
// from the keyframe at or before the target, discards everything earlier than the frame that
// covers the target, and shows that frame (frame accurate, like <video>).
//
// Video runs in lanes: a lane reads one rendition's packets ahead of the clock (the buffer ABR
// sees) and feeds its own decoder. A quality switch opens a lane on the new rendition at its first
// keyframe after what is already read and lets the old lane finish up to there, so the picture
// never stops (ADR-008 §5). A decoder that fails or stalls during playback is replaced by the WASM
// one inside this backend, from the keyframe before the current position.
//
// Decoders are plugins (BackendContext.decoders). Frames arrive through DecoderConfig.output as
// transferable objects, so decoding in a Worker pool changes where the Decoder runs, not this file.

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
  type DemuxVideoTrack,
  type EncodedChunk,
  type FrameSink,
  type I420Frame,
  type MediaBackend,
  type PacketStream,
  type PlaybackSnapshot,
  type TrackList,
  type VideoTrack,
} from '@otter-player/media';
import type { AbrDriver } from '@otter-player/pipeline';
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
/** Seconds of video packets read ahead of the clock (downloads for URL sources): ABR's buffer. */
const READ_AHEAD_S = 12;
/** Seconds of audio handed to the worklet ahead of the clock. */
const AUDIO_AHEAD_S = 1;
/** Frames queued before playback resumes after running dry. */
const RESUME_FRAMES = 3;
const TIME_UPDATE_MS = 250;
/** Playing this long without the AudioContext clock is reported (audioClockUnavailable). */
const PERF_REPORT_MS = 1000;
/** A decoder that has output before and then holds packets this long without a frame has stalled. */
const STALL_MS = 3000;
/** How often automatic quality is reconsidered (and not within this after a switch). */
const ABR_INTERVAL_MS = 1000;
/** A quality switch takes effect no sooner than this far (s) ahead of the clock. */
const SWITCH_LEAD_S = 1;
/** Segment length assumed for ABR when the source does not say. */
const DEFAULT_SEGMENT_S = 4;

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
const frameDims = (f: DecodedFrame): { width: number; height: number } =>
  isI420(f) ? { width: f.width, height: f.height } : { width: (f as VideoFrame).displayWidth, height: (f as VideoFrame).displayHeight };

/** Wakes waiting loops: on decoder output, render ticks, seeks, teardown; at the latest after `ms`. */
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

/** Where a decoder's callbacks go: re-pointed when a seek reuses the decoder for a new lane. */
interface DecoderOwner {
  lane: Lane;
  g: number;
}

/** One rendition being read and decoded. */
interface Lane {
  readonly track: DemuxVideoTrack;
  /** Set right after the lane exists (the pool may call back while creating it). */
  decoder: DecoderInstance;
  owner: DecoderOwner;
  /** The plugin the decoder comes from (a runtime fallback changes it). */
  plugin: Decoder;
  /** Packets read ahead, not yet decoded. */
  readonly packets: EncodedChunk[];
  /** Timestamp (µs) of the last packet read; -Infinity before any. */
  readTo: number;
  /** Timestamp (µs) of the last packet handed to the decoder; -Infinity before any. */
  fedTo: number;
  /** Packets at or after this (µs) belong to the next lane (quality switch). */
  stopAt: number;
  readDone: boolean;
  /** Fed, flushed and closed (or abandoned). */
  done: boolean;
  /** Has output a frame (stall detection starts then). */
  outputs: number;
  /** When packets went in with no frame out since (stall detection), undefined otherwise. */
  pendingSince: number | undefined;
  /** In the decode pool's queue: no stall detection until it starts. */
  queued: boolean;
}

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

  // Decoding state. `gen` changes on every seek; work of an older generation stops. `vgen` is the
  // video's: it also changes when only the video restarts (back from the background).
  let gen = 0;
  let vgen = 0;
  const queue: DecodedFrame[] = [];
  /** Video lanes in play order: the current one last; earlier ones finish up to its start. */
  let lanes: Lane[] = [];
  let videoPlugin: Decoder | undefined;
  /** Renditions the video decoder takes (quality ladder), and the current one. */
  let levels: DemuxVideoTrack[] = [];
  let current: DemuxVideoTrack | undefined;
  let autoQuality = true;
  let switching = false;
  let lastSwitchAt = 0;
  let driver: AbrDriver | undefined;
  let lastAbrAt = 0;
  let audioEos = false;
  let seek: { target: number; candidate: DecodedFrame | undefined; resume: boolean } | undefined;
  let shownAt = Number.NEGATIVE_INFINITY;
  let firstFrame = false;
  let dropped = 0;
  let total = 0;
  let lastTimeUpdate = 0;
  let cancelTick: (() => void) | undefined;
  let loaded: { resolve: () => void; reject: (e: unknown) => void } | undefined;
  /** Runtime fallback in progress or done (only once, then errors go to the session). */
  let fellBack = false;
  /**
   * Background (page hidden, ADR-008 §8): no video decoding (nothing would be drawn: animation
   * frames stop), audio and the clock go on. Back in view, video restarts at the clock.
   */
  let background = false;
  /** After a video restart: frames before this (µs) are not shown or counted. */
  let discardBeforeUs = Number.NEGATIVE_INFINITY;
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

  const videoEos = (): boolean => lanes.length === 0 || lanes.every((l) => l.done);

  const show = (frame: DecodedFrame): void => {
    shownAt = frameTime(frame);
    total++;
    const { width, height } = frameDims(frame);
    if (width > 0 && (width !== snap.videoWidth || height !== snap.videoHeight)) update({ videoWidth: width, videoHeight: height });
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

  /** Into the queue in timestamp order (two lanes overlap in time of arrival during a switch). */
  const enqueue = (frame: DecodedFrame): void => {
    const t = frameTime(frame);
    let i = queue.length;
    while (i > 0 && frameTime(queue[i - 1] as DecodedFrame) > t) i--;
    queue.splice(i, 0, frame);
  };

  const onVideoFrame = (lane: Lane, g: number, frame: DecodedFrame): void => {
    if (destroyed || g !== vgen) return closeFrame(frame);
    lane.outputs++;
    if (seek === undefined && frameTime(frame) < discardBeforeUs) {
      // Decoded from the keyframe before the clock on a video restart: not shown, not dropped.
      lane.pendingSince = lane.decoder.decodeQueueSize > 0 ? performance.now() : undefined;
      signal.notify();
      return closeFrame(frame);
    }
    // Progress: the stall timer restarts while packets are still in the decoder.
    lane.pendingSince = lane.decoder.decodeQueueSize > 0 ? performance.now() : undefined;
    signal.notify();
    const s = seek;
    if (s === undefined) {
      enqueue(frame);
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
      enqueue(frame);
    }
  };

  const onAudioData = (data: DecodedFrame): void => {
    if (destroyed || sink === undefined || isI420(data)) return closeFrame(data);
    sink.push(data as AudioData);
    signal.notify();
  };

  const decodedAhead = (): number => queue.length + lanes.reduce((n, l) => n + (l.done ? 0 : l.decoder.decodeQueueSize), 0);
  const audioAhead = (): boolean => {
    if (sink === undefined || clock === undefined) return false;
    return (audio?.decodeQueueSize ?? 0) > 16 || sink.bufferedEnd - clock.now() > AUDIO_AHEAD_S;
  };
  /** Seconds of video read ahead of the clock (what ABR calls the buffer). */
  const readAhead = (): number => {
    const lane = lanes.at(-1);
    if (lane === undefined || clock === undefined) return 0;
    if (lane.readDone) return Number.POSITIVE_INFINITY;
    return Math.max(0, lane.readTo / 1e6 - clock.now());
  };

  /** A decoder from the current video plugin; its callbacks follow `owner`. */
  const newDecoder = (track: DemuxVideoTrack, owner: DecoderOwner): DecoderInstance => {
    const plugin = videoPlugin as Decoder;
    return plugin.create({
      ...track.setup,
      output: (frame) => onVideoFrame(owner.lane, owner.g, frame),
      error: (err) => onVideoError(owner.lane, owner.g, err),
      // Over the decode pool's limit: playback starts when a slot frees; say why meanwhile.
      queued: (reason) => {
        owner.lane.queued = true;
        bus.emit('route-detail', { reason: `decoder queued: ${reason}` });
        bus.emit('error', createError({ type: 'media', details: 'decoderQueued', fatal: false, recoverable: true, message: reason }));
      },
      started: () => {
        owner.lane.queued = false;
      },
    });
  };

  /** Reads a lane's packets ahead of the clock, and feeds its decoder; ends with flush + close. */
  const runLane = async (lane: Lane, stream: PacketStream, g: number): Promise<void> => {
    const it = stream[Symbol.asyncIterator]();
    const live = (): boolean => g === vgen && !destroyed && !lane.done;
    const reader = (async () => {
      try {
        for (;;) {
          while (live() && clock !== undefined && lane.readTo / 1e6 - clock.now() > READ_AHEAD_S) await signal.wait(100);
          if (!live()) return;
          const next: IteratorResult<EncodedChunk> = await it.next();
          if (!live()) return;
          if (next.done === true || next.value.timestamp >= lane.stopAt) break;
          lane.packets.push(next.value);
          lane.readTo = next.value.timestamp;
          signal.notify();
        }
      } catch (err) {
        if (live()) fail(isOtterError(err) ? err : fatal('mux', 'demuxFailed', String(err), err));
      } finally {
        lane.readDone = true;
        signal.notify();
        void it.return?.();
      }
    })();
    try {
      for (;;) {
        // Bounded by what waits in the decoder and the queue, also while seeking (frames before
        // the target are dropped as they come, so the decoder's queue is what limits a seek).
        // In the background only a seek decodes (its frame must exist when the page comes back).
        const idle = (): boolean => background && seek === undefined;
        while (live() && (idle() || (lane.packets.length === 0 ? !lane.readDone : decodedAhead() >= VIDEO_AHEAD))) await signal.wait(idle() ? 250 : 20);
        if (!live()) return;
        const chunk = lane.packets.shift();
        if (chunk === undefined) break;
        // A switch moved the boundary after this was read.
        if (chunk.timestamp >= lane.stopAt) {
          lane.packets.length = 0;
          break;
        }
        lane.pendingSince ??= performance.now();
        lane.fedTo = Math.max(lane.fedTo, chunk.timestamp);
        lane.decoder.decode(chunk);
      }
      await reader;
      // Frames still held for reordering come out on flush.
      await lane.decoder.flush().catch(() => undefined);
      if (g !== vgen || destroyed) return;
      lane.done = true;
      lane.pendingSince = undefined;
      // A lane that handed over to the next one is not needed any more.
      if (lane !== lanes.at(-1)) {
        lane.decoder.close();
        lanes = lanes.filter((l) => l !== lane);
      }
      if (seek !== undefined && videoEos()) finishSeek(seek.candidate);
      signal.notify();
    } finally {
      if (!live()) void it.return?.();
    }
  };

  /** A lane on `track`; `reuse`: a decoder (reset) of an earlier lane on the same track. */
  const openLane = (track: DemuxVideoTrack, stream: PacketStream, g: number, reuse?: Lane): Lane => {
    const lane: Lane = {
      track,
      decoder: undefined as unknown as DecoderInstance,
      owner: undefined as unknown as DecoderOwner,
      plugin: videoPlugin as Decoder,
      packets: [],
      readTo: Number.NEGATIVE_INFINITY,
      fedTo: Number.NEGATIVE_INFINITY,
      stopAt: Number.POSITIVE_INFINITY,
      readDone: false,
      done: false,
      outputs: 0,
      pendingSince: undefined,
      queued: false,
    };
    if (reuse !== undefined) {
      lane.owner = reuse.owner;
      lane.owner.lane = lane;
      lane.owner.g = g;
      lane.decoder = reuse.decoder;
      lane.queued = reuse.queued;
    } else {
      lane.owner = { lane, g };
      lane.decoder = newDecoder(track, lane.owner);
    }
    lanes.push(lane);
    void runLane(lane, stream, g);
    return lane;
  };

  /**
   * Ends every lane. `keep`: the lane whose decoder the next lane reuses (reset, not closed), so a
   * seek does not create a decoder each time (decoder setup is costly; for the WASM build it is a
   * new embind object in the Worker).
   */
  const closeLanes = (keep?: Lane): void => {
    for (const l of lanes) {
      l.done = true;
      l.packets.length = 0;
      if (l === keep) l.decoder.reset();
      else l.decoder.close();
    }
    lanes = [];
  };

  /** Audio: one decoder, fed from `stream` until it ends or a newer generation takes over. */
  const pumpAudio = async (stream: PacketStream, g: number): Promise<void> => {
    const decoder = audio;
    if (decoder === undefined) return;
    const it = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next: IteratorResult<EncodedChunk> = await it.next();
        if (g !== gen || destroyed) return;
        if (next.done === true) break;
        while (audioAhead() && g === gen && !destroyed) await signal.wait();
        if (g !== gen || destroyed) return;
        decoder.decode(next.value);
      }
      await decoder.flush().catch(() => undefined);
      if (g === gen && !destroyed) audioEos = true;
    } catch (err) {
      if (g === gen) fail(isOtterError(err) ? err : fatal('mux', 'demuxFailed', String(err), err));
    } finally {
      if (g !== gen || destroyed) void it.return?.();
    }
  };

  const openVideoAt = async (d: Demuxer, track: DemuxVideoTrack, time: number): Promise<PacketStream> => {
    if (d.openVideo !== undefined && levels.length > 1) {
      const p = await d.openVideo(track.id, time, 'before');
      if (p !== null) return p.packets;
    }
    return d.seek('video', time);
  };

  const startSeek = (time: number, resume: boolean): void => {
    if (demuxer === undefined || info === undefined) return;
    const d = demuxer;
    const g = ++gen;
    const vg = ++vgen;
    discardBeforeUs = Number.NEGATIVE_INFINITY;
    signal.notify();
    if (seek !== undefined) closeFrame(seek.candidate);
    for (const f of queue.splice(0)) closeFrame(f);
    // Same rendition, same decoder plugin: the decoder is reset and reused.
    const last = lanes.at(-1);
    const reuse = last !== undefined && last.track === current && last.plugin === videoPlugin ? last : undefined;
    closeLanes(reuse);
    switching = false;
    audio?.reset();
    sink?.flush();
    audioEos = info.audio === null || audio === undefined;
    const target = Math.min(Math.max(time, 0), info.duration);
    clock?.stop();
    clock?.set(target);
    driver?.reset();
    seek = { target, candidate: undefined, resume };
    update({ seeking: true, ended: false, waiting: false, currentTime: target, paused: !resume });
    const track = current;
    if (track !== undefined) {
      void openVideoAt(d, track, target).then(
        (s) => {
          if (vg === vgen) openLane(track, s, vg, reuse);
          else reuse?.decoder.close();
        },
        (e: unknown) => fail(fatal('mux', 'demuxFailed', String(e), e)),
      );
    } else {
      finishSeek(undefined);
    }
    if (audio !== undefined) void d.seek('audio', target).then((s) => (g === gen ? pumpAudio(s, g) : undefined), (e: unknown) => fail(fatal('mux', 'demuxFailed', String(e), e)));
  };

  /**
   * Video alone restarts at the clock (back from the background): from the keyframe before it,
   * frames before the clock decoded but not shown; audio and the clock are not touched.
   */
  const resyncVideo = (): void => {
    const d = demuxer;
    const track = current;
    if (d === undefined || track === undefined || clock === undefined || seek !== undefined) return;
    const t = clock.now();
    // Paused and nothing missed: decoding just carries on from where it stopped.
    if (!clock.playing && !snap.waiting && lanes.length > 0) return;
    const vg = ++vgen;
    for (const f of queue.splice(0)) closeFrame(f);
    const last = lanes.at(-1);
    const reuse = last !== undefined && last.track === track && last.plugin === videoPlugin ? last : undefined;
    closeLanes(reuse);
    switching = false;
    discardBeforeUs = Math.round(t * 1e6) - Math.round(1e6 / (track.frameRate ?? 30));
    void openVideoAt(d, track, t).then(
      (s) => {
        if (vg === vgen) openLane(track, s, vg, reuse);
        else reuse?.decoder.close();
      },
      (e: unknown) => fail(fatal('mux', 'demuxFailed', String(e), e)),
    );
  };

  const onVisibility = (): void => {
    const hidden = typeof document === 'object' && document.visibilityState === 'hidden';
    if (hidden === background) return;
    background = hidden;
    signal.notify();
    if (hidden) {
      // Playing: decoded pictures would be stale on return, release them now (GPU memory).
      // Paused: they are the next ones to show, kept.
      if (seek === undefined && clock?.playing === true) for (const f of queue.splice(0)) closeFrame(f);
      // A slow timer keeps time, audio and `ended` going while animation frames stop.
      backgroundTimer = setInterval(() => {
        if (cancelTick !== undefined) {
          cancelTick();
          cancelTick = undefined;
        }
        tick();
      }, 250);
    } else {
      if (backgroundTimer !== undefined) clearInterval(backgroundTimer);
      backgroundTimer = undefined;
      if (cancelTick === undefined && !destroyed && clock !== undefined) cancelTick = schedule(tick);
      resyncVideo();
    }
  };
  let backgroundTimer: ReturnType<typeof setInterval> | undefined;

  const trackList = (): TrackList => ({
    video: levels.map(
      (v): VideoTrack => ({
        id: String(v.id),
        kind: 'video',
        codec: v.codec,
        width: v.width,
        height: v.height,
        ...(v.bitrate === undefined ? {} : { bitrate: v.bitrate }),
        ...(v.frameRate === undefined ? {} : { frameRate: v.frameRate }),
        selected: v === current,
      }),
    ),
    audio: info?.audio == null ? [] : [{ id: String(info.audio.id), kind: 'audio', codec: info.audio.codec, channels: info.audio.channels, selected: true }],
    text: [],
    quality: 'selectable',
    requestedQuality: autoQuality ? 'auto' : String(current?.id ?? 'auto'),
  });

  /**
   * Seamless quality switch: the new rendition starts at a keyframe, the current lane is cut there
   * and plays out. Manual switches and switches down take the first keyframe after what is decoded
   * (soon; read-ahead past it is dropped); automatic switches up the first after what is read
   * (no download wasted).
   */
  const switchTo = async (next: DemuxVideoTrack, reason: string, soon: boolean): Promise<void> => {
    const d = demuxer;
    const from = lanes.at(-1);
    if (d?.openVideo === undefined || next === current || switching || seek !== undefined || from === undefined || clock === undefined) return;
    switching = true;
    const g = vgen;
    try {
      // At least SWITCH_LEAD_S ahead of the clock: the new rendition's first segment has to be
      // downloaded and decoded from its keyframe before the old lane runs out there.
      const after = Math.max((soon ? from.fedTo : from.readTo) / 1e6, clock.now() + SWITCH_LEAD_S);
      const pos = await d.openVideo(next.id, after, 'after');
      if (g !== vgen || destroyed || pos === null) return;
      // Packets of the old rendition from the switch point on are not needed.
      from.stopAt = Math.round(pos.start * 1e6);
      const keep = from.packets.filter((p) => p.timestamp < from.stopAt);
      from.packets.length = 0;
      from.packets.push(...keep);
      current = next;
      lastSwitchAt = performance.now();
      openLane(next, pos.packets, g);
      tracks = trackList();
      bus.emit('tracks-change', tracks);
      bus.emit('quality-change', { id: String(next.id), auto: autoQuality, reason: `${reason}, from ${pos.start.toFixed(3)} s` });
      driver?.applied(levels.indexOf(next), levels.map((l) => ({ id: String(l.id), bitrate: l.bitrate ?? 0, width: l.width, height: l.height })));
    } catch (err) {
      if (g === vgen) fail(isOtterError(err) ? err : fatal('mux', 'demuxFailed', String(err), err));
    } finally {
      switching = false;
    }
  };

  const abrStep = (): void => {
    const now = performance.now();
    if (driver === undefined || !autoQuality || levels.length < 2 || current === undefined || seek !== undefined || switching) return;
    if (now - lastAbrAt < ABR_INTERVAL_MS || now - lastSwitchAt < ABR_INTERVAL_MS * 2) return;
    lastAbrAt = now;
    const ladder = levels.map((l) => ({ id: String(l.id), bitrate: l.bitrate ?? 0, width: l.width, height: l.height }));
    const decision = driver.decide({
      levels: ladder,
      current: levels.indexOf(current),
      bufferLevel: Math.min(readAhead(), READ_AHEAD_S),
      segmentDuration: info?.segmentDuration ?? DEFAULT_SEGMENT_S,
      live: false,
      lowLatency: false,
      bufferTarget: READ_AHEAD_S,
    });
    const next = levels[decision.engineLevel];
    if (next !== undefined && next !== current) void switchTo(next, decision.reason, (next.bitrate ?? 0) < (current.bitrate ?? 0));
  };

  /**
   * Runtime fallback (ADR-008 §5): the WebCodecs decoder failed or stalled during playback. The
   * WASM decoder takes over inside this backend, from the keyframe before the current position;
   * a second failure goes to the session (next step of the route).
   */
  const onVideoError = (lane: Lane, g: number, err: OtterError): void => {
    if (destroyed || g !== vgen || lane.done) return;
    const at = clock?.now() ?? snap.currentTime;
    const wasm = (ctx.decoders ?? []).find((d) => d.id.startsWith('wasm'));
    const codec = lane.track.codec;
    // During load the session's route does the same (and says so).
    if (loaded !== undefined || fellBack || videoPlugin?.id !== 'webcodecs' || wasm === undefined) return fail(err);
    fellBack = true;
    const resume = clock?.playing === true || snap.waiting;
    void wasm.supports(codec, ctx.caps).then((support) => {
      if (destroyed || g !== vgen) return;
      if (support === false) return fail(err);
      videoPlugin = wasm;
      bus.emit('route-detail', { candidate: 'webcodecs', outcome: 'failed', reason: `${err.details} at ${at.toFixed(3)} s (runtime)` });
      bus.emit('route-detail', {
        candidate: 'wasm',
        outcome: 'selected',
        reason: `runtime fallback inside backend-webcodecs: ${codec} on ${wasm.id}${wasm.describe === undefined ? '' : ` (${wasm.describe()})`}, from the keyframe before ${at.toFixed(3)} s`,
      });
      bus.emit(
        'error',
        createError({ type: 'media', details: 'decoderFallback', fatal: false, recoverable: true, message: `${err.details} on webcodecs at ${at.toFixed(3)} s; continuing on ${wasm.id}`, cause: err }),
      );
      startSeek(at, resume);
    });
  };

  const checkStalls = (): void => {
    const now = performance.now();
    for (const lane of lanes) {
      if (lane.done || lane.queued || lane.outputs === 0 || lane.pendingSince === undefined) continue;
      // Waiting for output only matters while frames are wanted (playing, seeking, or room ahead).
      if (now - lane.pendingSince > STALL_MS) {
        const stalled = createError({ type: 'media', details: 'decoderStalled', fatal: true, recoverable: true, message: `no frame for ${STALL_MS} ms with packets in the decoder` });
        lane.pendingSince = undefined;
        onVideoError(lane, vgen, stalled);
        return;
      }
    }
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
    checkStalls();
    const t = clock.now();
    if (seek === undefined) {
      // The latest frame at or before the clock; the ones before it were skipped (dropped).
      // Nothing is drawn in the background (the queue was released on hiding).
      let latest: DecodedFrame | undefined;
      while (!background && queue.length > 0 && frameTime(queue[0] as DecodedFrame) <= t * 1e6 + EPS_US) {
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
      const frameUs = 1e6 / (current?.frameRate ?? 30);
      if (playing && !background && current !== undefined && !videoEos() && queue.length === 0 && t * 1e6 > Math.max(shownAt, discardBeforeUs) + 2 * frameUs) {
        // Ran dry: hold the clock until a few frames are decoded.
        clock.stop();
        update({ waiting: true, currentTime: clock.now() });
        bus.emit('waiting', { position: clock.now() });
      } else if (snap.waiting && (queue.length >= RESUME_FRAMES || videoEos())) {
        clock.start();
        update({ waiting: false });
      }
      if ((playing || snap.waiting) && (background || videoEos()) && audioEos && queue.length === 0 && t >= info.duration - 1e-3) {
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
      if (playing && !background) abrStep();
    }
    // In the background the interval drives the ticks (animation frames do not run).
    if (!background) cancelTick = schedule(tick);
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
        videoPlugin = decoder;
        // The quality ladder: renditions this decoder takes, by bitrate.
        const all = info.videoTracks ?? [v];
        levels = [];
        for (const t of all) if (t === v || (await decoder.supports(t.codec, ctx.caps)) !== false) levels.push(t);
        levels.sort((x, y) => (x.bitrate ?? 0) - (y.bitrate ?? 0));
        current = v;
        if (levels.length > 1 && demuxer.openVideo !== undefined) {
          // ABR from the pipeline's rule stack, on demand (only sources with a ladder need it).
          const { createAbrDriver } = await import('@otter-player/pipeline');
          driver = createAbrDriver();
          demuxer.onDownload?.((dl) => {
            driver?.sampleDownload(dl.ms, dl.bytes, dl.ttfbMs);
            const bw = driver?.bandwidth;
            if (bw !== undefined) bus.emit('bandwidth', { estimate: bw.estimate, fast: bw.fast, slow: bw.slow });
          });
          const pick = opts.quality === undefined || opts.quality === 'auto' ? undefined : levels.find((l) => String(l.id) === opts.quality);
          if (pick !== undefined) {
            current = pick;
            autoQuality = false;
          } else {
            const ladder = levels.map((l) => ({ id: String(l.id), bitrate: l.bitrate ?? 0, width: l.width, height: l.height }));
            const first = driver.decide({ levels: ladder, current: levels.indexOf(v), bufferLevel: 0, segmentDuration: info.segmentDuration ?? DEFAULT_SEGMENT_S, live: false, lowLatency: false, bufferTarget: READ_AHEAD_S });
            current = levels[first.engineLevel] ?? v;
          }
        } else {
          levels = [v];
        }
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

      tracks = trackList();
      buffered = timeRanges(Math.max(0, info.startTime), info.duration);
      bus.emit('tracks-change', tracks);
      if (current !== undefined && levels.length > 1) bus.emit('quality-change', { id: String(current.id), auto: autoQuality, reason: autoQuality ? 'initial (ABR)' : 'initial (requested)' });
      bus.emit('buffered-change', { buffered });
      update({ duration: info.duration, bufferedEnd: info.duration, videoWidth: current?.width ?? 0, videoHeight: current?.height ?? 0, readyState: 1 });
      cancelTick = schedule(tick);
      if (typeof document === 'object') {
        document.addEventListener('visibilitychange', onVisibility);
        onVisibility();
      }
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
    selectQuality(id) {
      if (id === 'auto') {
        autoQuality = true;
        lastAbrAt = 0;
        tracks = trackList();
        bus.emit('tracks-change', tracks);
        return;
      }
      const next = levels.find((l) => String(l.id) === id);
      if (next === undefined) return;
      autoQuality = false;
      if (seek !== undefined || lanes.length === 0) {
        // Not playing a lane yet: the seek in progress picks it up.
        current = next;
        tracks = trackList();
        bus.emit('tracks-change', tracks);
        bus.emit('quality-change', { id, auto: false, reason: 'manual' });
        return;
      }
      void switchTo(next, 'manual', true);
    },
    on<E extends keyof BackendEvents>(e: E, h: (p: BackendEvents[E]) => void): Unsubscribe {
      return bus.on(e, (p) => h(p));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      gen++;
      vgen++;
      abort.abort();
      signal.notify();
      cancelTick?.();
      if (backgroundTimer !== undefined) clearInterval(backgroundTimer);
      if (typeof document === 'object') document.removeEventListener('visibilitychange', onVisibility);
      loaded?.reject(fatal('other', 'destroyed', 'backend destroyed during load'));
      loaded = undefined;
      if (seek !== undefined) closeFrame(seek.candidate);
      seek = undefined;
      for (const f of queue.splice(0)) closeFrame(f);
      closeLanes();
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
