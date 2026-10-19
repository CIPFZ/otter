// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/types/demuxer.ts, Apache-2.0
import type { ChunkMetadata } from '../otter/shims.js';
import type { DecryptData } from '../otter/shims.js';
// Otter: fMP4 passthrough types (InitData, ParsedSampleData) are not copied.
type InitData = unknown;
type ParsedSampleData = unknown;
import type { RationalTimestamp } from '../utils/timescale-conversion.js';

export interface Demuxer {
  demux(
    data: Uint8Array,
    timeOffset: number,
    chunkMeta: ChunkMetadata,
    isSampleAes?: boolean,
    flush?: boolean,
  ): DemuxerResult | undefined;
  // Otter: demuxSampleAes removed (SAMPLE-AES not supported by the Otter pipeline).
  flush(
    timeOffset: number,
    chunkMeta: ChunkMetadata,
  ): DemuxerResult | Promise<DemuxerResult>;
  destroy(): void;
  resetInitSegment(
    initSegment: Uint8Array | undefined,
    audioCodec: string | undefined,
    videoCodec: string | undefined,
    trackDuration: number,
    decryptdata: DecryptData | null,
    chunkMeta: ChunkMetadata,
  ): void;
  resetTimeStamp(defaultInitPTS?: RationalTimestamp | null): void;
  resetContiguity(): void;
}

export interface DemuxerResult {
  audioTrack: DemuxedAudioTrack;
  videoTrack: DemuxedVideoTrackBase;
  id3Track: DemuxedMetadataTrack;
  textTrack: DemuxedUserdataTrack;
  initData?: InitData | undefined;
  sampleData?: ParsedSampleData | undefined;
}

export interface DemuxedTrack {
  type: string;
  id: number;
  pid: number;
  inputTimeScale: number;
  sequenceNumber: number;
  samples:
    | AudioSample[]
    | VideoSample[]
    | MetadataSample[]
    | UserdataSample[]
    | Uint8Array;
  timescale?: number | undefined;
  container?: string | undefined;
  dropped: number;
  duration?: number | undefined;
  pesData?: ElementaryStreamData | null | undefined;
  codec?: string | undefined;
}

export interface PassthroughTrack extends DemuxedTrack {
  sampleDuration: number;
  samples: Uint8Array<ArrayBuffer>;
  timescale: number;
  duration: number;
  codec: string;
  supplemental: string | undefined;
}
export interface DemuxedAudioTrack extends DemuxedTrack {
  type: 'audio';
  segmentCodec: 'aac' | 'ac3' | 'mp3';
  config?: number[] | Uint8Array | undefined;
  samplerate?: number | undefined;
  channelCount?: number | undefined;
  manifestCodec?: string | undefined;
  parsedCodec?: string | undefined;
  samples: AudioSample[];
}

export type DemuxedAAC = DemuxedAudioTrack & {
  segmentCodec: 'aac';
  samples: AACAudioSample[];
};

export type DemuxedAC3 = DemuxedAudioTrack & {
  segmentCodec: 'ac3';
  config: Uint8Array;
};

export interface DemuxedVideoTrackBase extends DemuxedTrack {
  width?: number | undefined;
  height?: number | undefined;
  pixelRatio?: [number, number] | undefined;
  audFound?: boolean | undefined;
  vps?: Uint8Array[] | undefined;
  pps?: Uint8Array[] | undefined;
  sps?: Uint8Array[] | undefined;
  naluState?: number | undefined;
  segmentCodec?: string | undefined;
  manifestCodec?: string | undefined;
  samples: VideoSample[] | Uint8Array;
  params?: object | undefined;
}

export interface DemuxedVideoTrack extends DemuxedVideoTrackBase {
  type: 'video';
  segmentCodec: 'avc' | 'hevc';
  samples: VideoSample[];
  pixelRatio: [number, number];
  width: number;
  height: number;
}

export type DemuxedAVC1 = DemuxedVideoTrack & {
  segmentCodec: 'avc';
  pps: Uint8Array[];
  sps: Uint8Array[];
};

export type DemuxedHEVC = DemuxedVideoTrack & {
  segmentCodec: 'hevc';
  params: {
    general_profile_space: number;
    general_tier_flag: number;
    general_profile_idc: number;
    general_profile_compatibility_flags: number[];
    general_constraint_indicator_flags: number[];
    general_level_idc: number;
    min_spatial_segmentation_idc: number;
    parallelismType: number;
    chroma_format_idc: number;
    bit_depth_luma_minus8: number;
    bit_depth_chroma_minus8: number;
    frame_rate: { fps: string; fixed: boolean };
    temporal_id_nested: number;
    num_temporal_layers: number;
  };
  pps: Uint8Array[];
  sps: Uint8Array[];
  vps: Uint8Array;
};

export interface DemuxedMetadataTrack extends DemuxedTrack {
  samples: MetadataSample[];
}

export interface DemuxedUserdataTrack extends DemuxedTrack {
  samples: UserdataSample[];
}

// Otter: enum -> const object + type (erasableSyntaxOnly); same values.
export const MetadataSchema = {
  audioId3: 'org.id3',
  dateRange: 'com.apple.quicktime.HLS',
  emsg: 'https://aomedia.org/emsg/ID3',
  misbklv: 'urn:misb:KLV:bin:1910.1',
} as const;
export type MetadataSchema = (typeof MetadataSchema)[keyof typeof MetadataSchema];
export interface MetadataSample {
  pts: number;
  dts: number;
  duration: number;
  len?: number | undefined;
  data: Uint8Array;
  type: MetadataSchema;
}

export interface UserdataSample {
  pts: number;
  bytes?: Uint8Array | undefined;
  type?: number | undefined;
  payloadType?: number | undefined;
  uuid?: string | undefined;
  userData?: string | undefined;
  userDataBytes?: Uint8Array | undefined;
}

export interface VideoSample {
  dts: number;
  pts: number;
  key: boolean;
  frame: boolean;
  units: VideoSampleUnit[];
  length: number;
}

export interface VideoSampleUnit {
  data: Uint8Array;
  type: number;
  state?: number | undefined;
}

export type AudioSample = {
  unit: Uint8Array;
  pts: number;
};

export type AACAudioSample = {
  unit: Uint8Array<ArrayBuffer>;
};

export type AudioFrame = {
  sample: AudioSample;
  length: number;
  missing: number;
};

export interface ElementaryStreamData {
  data: Uint8Array[];
  size: number;
}

export interface KeyData {
  method: string;
  key: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
}
