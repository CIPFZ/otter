// FLV demuxer output -> hls.js track model (ADR-007 §2), so the one hls.js remuxer serves FLV and
// TS. FLV NAL units are length-prefixed and come with an avcC / hvcC record; hls.js wants bare NAL
// units plus raw parameter sets, which its own SPS / VPS / PPS readers turn into the track fields.

import { AvcVideoParser, HevcVideoParser, parseSEIMessageFromNALu, type DemuxedAudioTrack, type DemuxedUserdataTrack, type DemuxedVideoTrack } from '@otter-vendor/hls.js';
import type { FlvAudioSample, FlvTrackMeta, FlvVideoSample } from '@otter-vendor/mpegts.js';
import { parseAvcC, parseHvcC } from './param-sets.js';

export interface FlvTrackState {
  audio: FlvTrackMeta | undefined;
  video: FlvTrackMeta | undefined;
}

/** FLV timestamps are milliseconds. */
const FLV_TIMESCALE = 1000;

interface VideoBase {
  readonly lengthSize: number;
  readonly track: DemuxedVideoTrack;
  readonly record: Uint8Array;
}

const cache = new WeakMap<FlvTrackMeta, VideoBase>();

/** Builds (once per decoder configuration record) the hls.js video track with parameter sets. */
function videoBase(meta: FlvTrackMeta): VideoBase | undefined {
  const record = meta.avcc ?? meta.hvcc;
  if (record === undefined) return undefined;
  const cached = cache.get(meta);
  if (cached !== undefined && cached.record === record) return cached;
  const track = {
    type: 'video',
    id: 1,
    pid: 1,
    inputTimeScale: FLV_TIMESCALE,
    sequenceNumber: 0,
    samples: [],
    dropped: 0,
    width: meta.codecWidth ?? 0,
    height: meta.codecHeight ?? 0,
    pixelRatio: [1, 1],
  } as unknown as DemuxedVideoTrack;
  let lengthSize: number;
  if (meta.avcc !== undefined) {
    const cfg = parseAvcC(meta.avcc);
    lengthSize = cfg.lengthSize;
    const sps = cfg.sps[0] as Uint8Array;
    const read = new AvcVideoParser().readSPS(sps);
    Object.assign(track, { segmentCodec: 'avc', sps: cfg.sps, pps: cfg.pps, width: read.width, height: read.height, pixelRatio: read.pixelRatio });
    track.codec = meta.codec;
  } else {
    const cfg = parseHvcC(meta.hvcc as Uint8Array);
    lengthSize = cfg.lengthSize;
    const parser = new HevcVideoParser();
    const sps = parser.readSPS(cfg.sps[0] as Uint8Array);
    const params: Record<string, unknown> = { ...parser.readVPS(cfg.vps[0] as Uint8Array), ...sps.params, ...parser.readPPS(cfg.pps[0] as Uint8Array) };
    Object.assign(track, { segmentCodec: 'hevc', vps: cfg.vps, sps: cfg.sps, pps: cfg.pps, params, width: sps.width, height: sps.height, pixelRatio: sps.pixelRatio });
    track.codec = sps.codecString;
  }
  const base = { lengthSize, track, record };
  cache.set(meta, base);
  return base;
}

function audioTrack(meta: FlvTrackMeta | undefined, samples: readonly FlvAudioSample[]): DemuxedAudioTrack {
  const base = {
    type: 'audio',
    id: 2,
    pid: meta === undefined ? -1 : 2,
    inputTimeScale: FLV_TIMESCALE,
    sequenceNumber: 0,
    dropped: 0,
    segmentCodec: 'aac',
    samples: samples.map((s) => ({ unit: s.unit, pts: s.pts, dts: s.dts })),
  } as unknown as DemuxedAudioTrack;
  if (meta !== undefined && meta.config !== undefined) {
    Object.assign(base, {
      config: Array.from(meta.config),
      samplerate: meta.audioSampleRate,
      channelCount: meta.channelCount,
      codec: meta.codec,
      parsedCodec: meta.codec,
      manifestCodec: meta.originalCodec,
    });
  }
  return base;
}

/**
 * Persistent hls.js tracks fed by FLV batches. The remuxer empties `samples` of a track it
 * remuxes and leaves them otherwise (e.g. until a second video sample arrives), exactly as with
 * hls.js' own TS demuxer, so samples accumulate here between calls.
 */
export interface HlsTrackPair {
  readonly audio: DemuxedAudioTrack;
  readonly video: DemuxedVideoTrack;
  /** SEI user data (CEA-608 cc_data), as hls.js' TS demuxer fills it. */
  readonly text: DemuxedUserdataTrack;
}

export function createTrackPair(): HlsTrackPair {
  return {
    audio: { type: 'audio', id: 2, pid: -1, inputTimeScale: FLV_TIMESCALE, sequenceNumber: 0, samples: [], dropped: 0, segmentCodec: 'aac' } as unknown as DemuxedAudioTrack,
    video: { type: 'video', id: 1, pid: -1, inputTimeScale: FLV_TIMESCALE, sequenceNumber: 0, samples: [], dropped: 0, width: 0, height: 0, pixelRatio: [1, 1], segmentCodec: 'avc' } as unknown as DemuxedVideoTrack,
    text: { type: 'text', id: 4, pid: -1, inputTimeScale: FLV_TIMESCALE, sequenceNumber: 0, samples: [], dropped: 0 } as unknown as DemuxedUserdataTrack,
  };
}

/**
 * Appends an FLV batch to the persistent tracks, updating codec configuration first. Returns false
 * while the video decoder configuration of a stream with video is still unknown.
 */
export function appendFlvSamples(pair: HlsTrackPair, state: FlvTrackState, audio: readonly FlvAudioSample[], video: readonly FlvVideoSample[]): boolean {
  if (state.audio !== undefined) {
    const a = audioTrack(state.audio, []);
    Object.assign(pair.audio, { pid: a.pid, config: a.config, samplerate: a.samplerate, channelCount: a.channelCount, codec: a.codec, parsedCodec: a.parsedCodec, manifestCodec: a.manifestCodec });
  }
  for (const s of audio) pair.audio.samples.push({ unit: s.unit, pts: s.pts, dts: s.dts } as DemuxedAudioTrack['samples'][number]);
  if (state.video === undefined) return video.length === 0;
  const base = videoBase(state.video);
  if (base === undefined) return false;
  const { lengthSize, track } = base;
  const { samples: _unused, ...fields } = track;
  Object.assign(pair.video, fields);
  const hevc = state.video.hvcc !== undefined;
  for (const s of video) {
    // SEI (AVC 6, HEVC prefix / suffix 39 / 40) carries CEA-608 cc_data: parsed like hls.js' TS
    // demuxer does, so both pipelines hand the remuxer the same user-data samples.
    for (const u of s.units) {
      if (hevc ? u.type === 39 || u.type === 40 : u.type === 6) parseSEIMessageFromNALu(u.data.subarray(lengthSize), hevc ? 2 : 1, s.pts, pair.text.samples);
    }
    pair.video.samples.push({
      dts: s.dts,
      pts: s.pts,
      key: s.isKeyframe,
      frame: true,
      length: s.length - s.units.length * lengthSize,
      // FLV units carry their length prefix; the remuxer writes its own.
      units: s.units.map((u) => ({ type: u.type, data: u.data.subarray(lengthSize) })),
    });
  }
  return true;
}
