// Transmuxers (ADR-007 §2): FLV or MPEG-TS bytes in, fMP4 out, through the L2 copies of the
// mpegts.js FLV demuxer and the hls.js TS demuxer + fMP4 remuxer. Pure and DOM-free: the engine
// feeds network chunks and appends the output to MSE (or a Worker posts it back).

import {
  DEFAULT_DEMUX_CONFIG,
  logger,
  MP4Remuxer,
  TSDemuxer,
  type ChunkMetadata,
  type DemuxedAudioTrack,
  type DemuxedVideoTrack,
  type HlsEventEmitter,
} from '@otter-vendor/hls.js';
import { DemuxErrors, FLVDemuxer } from '@otter-vendor/mpegts.js';
import { appendFlvSamples, createTrackPair, type FlvTrackState } from './flv-tracks.js';

/** One init segment per SourceBuffer. */
export interface InitSegment {
  readonly type: 'audio' | 'video';
  /** Full MSE type, e.g. `video/mp4; codecs="avc1.42c01e"`. */
  readonly mimeType: string;
  readonly codec: string;
  readonly data: Uint8Array;
}

export interface MediaFragment {
  readonly type: 'audio' | 'video';
  /** moof + mdat. */
  readonly data: Uint8Array;
  /** Seconds on the media timeline (0 = first sample of the stream). */
  readonly startPTS: number;
  readonly endPTS: number;
  readonly startDTS: number;
  readonly endDTS: number;
  /** Video fragment that starts with a keyframe. */
  readonly independent?: boolean;
}

export interface TransmuxResult {
  /** New init segments (first output, or after a codec / resolution change). */
  readonly init: readonly InitSegment[];
  readonly fragments: readonly MediaFragment[];
}

export interface TransmuxError {
  readonly fatal: boolean;
  readonly details: string;
  readonly message: string;
}

export interface Transmuxer {
  /** Feed bytes as they arrive; returns what could be remuxed so far. */
  push(chunk: Uint8Array): TransmuxResult;
  /** End of input: remux the remaining samples. */
  flush(): TransmuxResult;
  /** Discontinuity (seek, reconnect): next output starts a new timeline segment. */
  reset(): void;
  readonly errors: readonly TransmuxError[];
  /** Media info once known (codecs, size), for tracks-change. */
  readonly info: { readonly width?: number; readonly height?: number; readonly videoCodec?: string; readonly audioCodec?: string; readonly hasAudio: boolean; readonly hasVideo: boolean };
}

const TYPE_SUPPORTED = { mpeg: false, mp3: false, ac3: false };
const META: ChunkMetadata = { sn: 0, iframe: false, duration: 0 };

/** Collects remuxer / demuxer error events. */
function collector(errors: TransmuxError[]): HlsEventEmitter {
  return {
    emit: (_event, _name, data) => {
      errors.push({ fatal: data.fatal, details: data.details, message: data.reason ?? data.error?.message ?? data.details });
      return true;
    },
  };
}

/** Shared remux step: hls.js tracks -> init segments + fragments. */
function createRemuxStep(errors: TransmuxError[]) {
  const observer = collector(errors);
  let remuxer = new MP4Remuxer(observer, DEFAULT_DEMUX_CONFIG, TYPE_SUPPORTED, logger);
  const empty = <T>(type: string, id: number): T => ({ type, id, pid: -1, inputTimeScale: 90000, sequenceNumber: 0, samples: [], dropped: 0 }) as unknown as T;
  return {
    run(audio: DemuxedAudioTrack, video: DemuxedVideoTrack, flush: boolean): TransmuxResult {
      const r = remuxer.remux(audio, video, empty('id3', 3), empty('text', 4), 0, true, flush, 'main', META);
      const init: InitSegment[] = [];
      const tracks = r.initSegment?.tracks;
      for (const type of ['video', 'audio'] as const) {
        const t = tracks?.[type];
        if (t?.initSegment === undefined) continue;
        const codec = t.codec ?? '';
        init.push({ type, codec, mimeType: `${t.container}; codecs="${codec}"`, data: t.initSegment });
      }
      const fragments: MediaFragment[] = [];
      for (const [type, track] of [['video', r.video], ['audio', r.audio]] as const) {
        if (track === undefined || track.data1 === undefined) continue;
        const data = track.data2 === undefined ? track.data1 : concat(track.data1, track.data2);
        fragments.push({
          type,
          data,
          startPTS: track.startPTS,
          endPTS: track.endPTS,
          startDTS: track.startDTS,
          endDTS: track.endDTS,
          ...(type === 'video' && r.independent !== undefined ? { independent: r.independent } : {}),
        });
      }
      return { init, fragments };
    },
    reset(): void {
      remuxer.destroy();
      remuxer = new MP4Remuxer(observer, DEFAULT_DEMUX_CONFIG, TYPE_SUPPORTED, logger);
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

const merge = (results: readonly TransmuxResult[]): TransmuxResult => ({
  init: results.flatMap((r) => r.init),
  fragments: results.flatMap((r) => r.fragments),
});

/** HTTP-FLV / WS-FLV (mpegts.js demuxer, L2) -> fMP4 (hls.js remuxer, L2). */
export function createFlvTransmuxer(): Transmuxer {
  const errors: TransmuxError[] = [];
  const remux = createRemuxStep(errors);
  const state: FlvTrackState = { audio: undefined, video: undefined };
  let tracks = createTrackPair();
  let demuxer: FLVDemuxer | undefined;
  let pending: Uint8Array = new Uint8Array(0);
  let byteStart = 0;
  let out: TransmuxResult[] = [];
  const info = { hasAudio: false, hasVideo: false } as { -readonly [K in keyof Transmuxer['info']]: Transmuxer['info'][K] };

  const create = (header: ArrayBuffer): FLVDemuxer | undefined => {
    const probe = FLVDemuxer.probe(header);
    if (probe.match !== true) return undefined;
    const d = new FLVDemuxer(probe, {});
    info.hasAudio = probe.hasAudioTrack === true;
    info.hasVideo = probe.hasVideoTrack === true;
    d.onError = (type, message) => {
      errors.push({ fatal: type !== DemuxErrors.FORMAT_ERROR, details: `flv${type}`, message });
    };
    d.onMediaInfo = (mi) => {
      if (mi.width !== null) info.width = mi.width;
      if (mi.height !== null) info.height = mi.height;
      if (mi.videoCodec !== null) info.videoCodec = mi.videoCodec;
      if (mi.audioCodec !== null) info.audioCodec = mi.audioCodec;
      info.hasAudio = mi.hasAudio === true;
      info.hasVideo = mi.hasVideo === true;
    };
    d.onTrackMetadata = (type, meta) => {
      state[type] = meta;
    };
    d.onDataAvailable = (audio, video) => {
      const ready = appendFlvSamples(tracks, state, audio.samples, video.samples);
      // Handed over: reset the demuxer's batch (samples and its byte counters, as mpegts.js does).
      audio.samples = [];
      audio.length = 0;
      video.samples = [];
      video.length = 0;
      if (ready) out.push(remux.run(tracks.audio, tracks.video, false));
    };
    return d;
  };

  return {
    errors,
    info,
    push(chunk) {
      const merged = pending.byteLength === 0 ? chunk : concat(pending, chunk);
      const buffer = merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength) as ArrayBuffer;
      if (demuxer === undefined) {
        if (merged.byteLength < 13) {
          pending = merged;
          return { init: [], fragments: [] };
        }
        demuxer = create(buffer);
        if (demuxer === undefined) {
          errors.push({ fatal: true, details: 'flvBadHeader', message: 'not an FLV stream' });
          return { init: [], fragments: [] };
        }
      }
      const consumed = demuxer.parseChunks(buffer, byteStart);
      byteStart += consumed;
      pending = merged.slice(consumed);
      const result = merge(out);
      out = [];
      return result;
    },
    flush() {
      return remux.run(tracks.audio, tracks.video, true);
    },
    reset() {
      remux.reset();
      state.audio = state.video = undefined;
      tracks = createTrackPair();
      demuxer?.destroy();
      demuxer = undefined;
      pending = new Uint8Array(0);
      byteStart = 0;
      out = [];
    },
  };
}

/** MPEG-TS (hls.js demuxer + remuxer, L2) -> fMP4. */
export function createTsTransmuxer(): Transmuxer {
  const errors: TransmuxError[] = [];
  const observer = collector(errors);
  const remux = createRemuxStep(errors);
  let demuxer = new TSDemuxer(observer, DEFAULT_DEMUX_CONFIG, TYPE_SUPPORTED, logger);
  let started = false;
  const info = { hasAudio: false, hasVideo: false } as { -readonly [K in keyof Transmuxer['info']]: Transmuxer['info'][K] };

  const describe = (audio: DemuxedAudioTrack, video: DemuxedVideoTrack): void => {
    info.hasAudio = audio.pid > -1;
    info.hasVideo = video.pid > -1;
    if (video.width > 0) info.width = video.width;
    if (video.height > 0) info.height = video.height;
    if (video.codec !== undefined) info.videoCodec = video.codec;
    if (audio.codec !== undefined) info.audioCodec = audio.codec;
  };

  return {
    errors,
    info,
    push(chunk) {
      if (!started) {
        started = true;
        demuxer.resetInitSegment(undefined, 'mp4a.40.2', 'avc1.42e01e', 0, null, META);
      }
      const r = demuxer.demux(chunk, 0, META, false, false);
      // TS demuxing always yields a sample-array video track (hls.js' transmuxer casts the same way).
      const video = r.videoTrack as DemuxedVideoTrack;
      describe(r.audioTrack, video);
      return remux.run(r.audioTrack, video, false);
    },
    flush() {
      const r = demuxer.flush(0, META) as ReturnType<TSDemuxer['demux']>;
      const video = r.videoTrack as DemuxedVideoTrack;
      describe(r.audioTrack, video);
      return remux.run(r.audioTrack, video, true);
    },
    reset() {
      remux.reset();
      demuxer.destroy();
      demuxer = new TSDemuxer(observer, DEFAULT_DEMUX_CONFIG, TYPE_SUPPORTED, logger);
      started = false;
    },
  };
}
