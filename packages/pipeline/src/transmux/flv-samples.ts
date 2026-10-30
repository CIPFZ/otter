// FLV samples for decoders that take encoded frames (WebCodecs, ADR-013 §7): the same mpegts.js
// FLV demuxer (L2) as the fMP4 transmuxer, but its samples come out as they are instead of being
// remuxed. Video: the AVC / HEVC sample as stored (length-prefixed NAL units: the "avc" format a
// decoder configured with the avcC / hvcC record expects); audio: raw AAC frames with the
// AudioSpecificConfig. Codec strings and sizes come from the parameter sets, as the remuxer's do.
// Pure and DOM-free; timestamps in milliseconds, as FLV has them.

import { AvcVideoParser, HevcVideoParser } from '@otter-vendor/hls.js';
import { DemuxErrors, FLVDemuxer, type FlvTrackMeta } from '@otter-vendor/mpegts.js';
import { parseAvcC, parseHvcC } from './param-sets.js';
import type { TransmuxError } from './transmuxer.js';

export interface FlvVideoConfig {
  /** RFC 6381, e.g. `avc1.42c01e`, `hvc1.1.6.L93.B0`. */
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  /** The avcC / hvcC record (decoder `description`). */
  readonly description: Uint8Array;
}

export interface FlvAudioConfig {
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
  /** AudioSpecificConfig (decoder `description`). */
  readonly description: Uint8Array;
}

export interface FlvVideoFrame {
  readonly key: boolean;
  /** Milliseconds. */
  readonly dts: number;
  readonly pts: number;
  readonly data: Uint8Array;
}

export interface FlvAudioFrame {
  readonly pts: number;
  readonly data: Uint8Array;
}

export interface FlvSamples {
  /** A new video configuration (first one, or a change mid-stream) comes before its frames. */
  readonly videoConfig?: FlvVideoConfig;
  readonly audioConfig?: FlvAudioConfig;
  readonly video: readonly FlvVideoFrame[];
  readonly audio: readonly FlvAudioFrame[];
}

export interface FlvSampleReader {
  /** Feed bytes as they arrive; returns the samples parsed so far. */
  push(chunk: Uint8Array): FlvSamples;
  readonly errors: readonly TransmuxError[];
  /** From the FLV header: whether the stream declares audio / video. */
  readonly declared: { readonly audio: boolean; readonly video: boolean } | undefined;
}

/** Codec string and size of a video track from its decoder configuration record. */
export function flvVideoConfig(meta: FlvTrackMeta): FlvVideoConfig | undefined {
  if (meta.avcc !== undefined) {
    const sps = parseAvcC(meta.avcc).sps[0] as Uint8Array;
    const read = new AvcVideoParser().readSPS(sps);
    const codec = meta.codec ?? `avc1.${[1, 2, 3].map((i) => (sps[i] ?? 0).toString(16).padStart(2, '0')).join('')}`;
    return { codec, width: read.width, height: read.height, description: meta.avcc };
  }
  if (meta.hvcc !== undefined) {
    const sps = new HevcVideoParser().readSPS(parseHvcC(meta.hvcc).sps[0] as Uint8Array);
    return { codec: sps.codecString, width: sps.width, height: sps.height, description: meta.hvcc };
  }
  return undefined;
}

function flvAudioConfig(meta: FlvTrackMeta): FlvAudioConfig | undefined {
  if (meta.config === undefined || meta.audioSampleRate === undefined || meta.channelCount === undefined) return undefined;
  return { codec: meta.codec ?? 'mp4a.40.2', sampleRate: meta.audioSampleRate, channels: meta.channelCount, description: Uint8Array.from(meta.config) };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

export function createFlvSampleReader(): FlvSampleReader {
  const errors: TransmuxError[] = [];
  let demuxer: FLVDemuxer | undefined;
  let declared: FlvSampleReader['declared'];
  let pending: Uint8Array = new Uint8Array(0);
  let byteStart = 0;
  let videoConfig: FlvVideoConfig | undefined;
  let out: { videoConfig?: FlvVideoConfig; audioConfig?: FlvAudioConfig; video: FlvVideoFrame[]; audio: FlvAudioFrame[] } = { video: [], audio: [] };

  const create = (header: ArrayBuffer): FLVDemuxer | undefined => {
    const probe = FLVDemuxer.probe(header);
    if (probe.match !== true) return undefined;
    declared = { audio: probe.hasAudioTrack === true, video: probe.hasVideoTrack === true };
    const d = new FLVDemuxer(probe, {});
    d.onError = (type, message) => {
      errors.push({ fatal: type !== DemuxErrors.FORMAT_ERROR, details: `flv${type}`, message });
    };
    d.onMediaInfo = () => undefined;
    d.onTrackMetadata = (type, meta) => {
      if (type === 'video') {
        const c = flvVideoConfig(meta);
        if (c !== undefined && c.description !== videoConfig?.description) out.videoConfig = videoConfig = c;
      } else {
        const c = flvAudioConfig(meta);
        if (c !== undefined) out.audioConfig = c;
      }
    };
    d.onDataAvailable = (audio, video) => {
      for (const s of audio.samples) out.audio.push({ pts: s.pts, data: s.unit });
      for (const s of video.samples) {
        // The sample as stored: its units with their length prefixes, one after the other.
        const data = new Uint8Array(s.units.reduce((n, u) => n + u.data.byteLength, 0));
        let o = 0;
        for (const u of s.units) {
          data.set(u.data, o);
          o += u.data.byteLength;
        }
        out.video.push({ key: s.isKeyframe, dts: s.dts, pts: s.pts, data });
      }
      // Handed over: reset the demuxer's batch (samples and its byte counters, as mpegts.js does).
      audio.samples = [];
      audio.length = 0;
      video.samples = [];
      video.length = 0;
    };
    return d;
  };

  return {
    errors,
    get declared() {
      return declared;
    },
    push(chunk) {
      const merged = pending.byteLength === 0 ? chunk : concat(pending, chunk);
      const buffer = merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength) as ArrayBuffer;
      if (demuxer === undefined) {
        if (merged.byteLength < 13) {
          pending = merged;
          return { video: [], audio: [] };
        }
        demuxer = create(buffer);
        if (demuxer === undefined) {
          errors.push({ fatal: true, details: 'flvBadHeader', message: 'not an FLV stream' });
          return { video: [], audio: [] };
        }
      }
      const consumed = demuxer.parseChunks(buffer, byteStart);
      byteStart += consumed;
      pending = merged.slice(consumed);
      const result = out;
      out = { video: [], audio: [] };
      return result;
    },
  };
}
