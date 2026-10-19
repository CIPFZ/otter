// Derived from hls.js@b023c2908c53b8cbe25665de4df9713cd3bbfdbf src/types/remuxer.ts, Apache-2.0
import type { SourceBufferName } from '../otter/shims.js';
import type {
  DemuxedAudioTrack,
  DemuxedMetadataTrack,
  DemuxedUserdataTrack,
  DemuxedVideoTrack,
  DemuxedVideoTrackBase,
  MetadataSample,
  UserdataSample,
} from './demuxer.js';
import type { PlaylistLevelType } from '../otter/shims.js';
import type { TrackSet } from '../otter/shims.js';
import type { ChunkMetadata } from '../otter/shims.js';
import type { DecryptData } from '../otter/shims.js';
// Otter: fMP4 passthrough types (InitData, ParsedSampleData) are not copied.
type InitData = unknown;
type ParsedSampleData = unknown;
import type { TimestampOffset } from '../utils/timescale-conversion.js';

export interface Remuxer {
  remux(
    audioTrack: DemuxedAudioTrack,
    videoTrack: DemuxedVideoTrackBase,
    id3Track: DemuxedMetadataTrack,
    textTrack: DemuxedUserdataTrack,
    timeOffset: number,
    accurateTimeOffset: boolean,
    flush: boolean,
    playlistType: PlaylistLevelType,
    chunkMeta: ChunkMetadata,
    initData?: InitData,
    sampleData?: ParsedSampleData,
  ): RemuxerResult | undefined;
  resetInitSegment(
    initSegment: Uint8Array | undefined,
    audioCodec: string | undefined,
    videoCodec: string | undefined,
    decryptdata: DecryptData | null,
  ): void;
  resetTimeStamp(defaultInitPTS: TimestampOffset | null): void;
  resetNextTimestamp(): void;
  destroy(): void;
}

export interface RemuxedTrack {
  data1: Uint8Array<ArrayBuffer>;
  data2?: Uint8Array<ArrayBuffer> | undefined;
  startPTS: number;
  endPTS: number;
  startDTS: number;
  endDTS: number;
  type: SourceBufferName;
  hasAudio: boolean;
  hasVideo: boolean;
  independent?: boolean | undefined;
  firstKeyFrame?: number | undefined;
  firstKeyFramePTS?: number | undefined;
  nb: number;
  transferredData1?: ArrayBuffer | undefined;
  transferredData2?: ArrayBuffer | undefined;
  dropped?: number | undefined;
  encrypted?: boolean | undefined;
}

export interface RemuxedMetadata {
  samples: MetadataSample[];
}

export interface RemuxedUserdata {
  samples: UserdataSample[];
}

export type Mp4SampleFlags = {
  isLeading: 0;
  isDependedOn: 0;
  hasRedundancy: 0;
  degradPrio: 0;
  dependsOn: 1 | 2;
  isNonSync: 0 | 1;
  paddingValue: 0;
};

export type Mp4Sample = {
  size: number;
  duration: number;
  cts: number;
  flags: Mp4SampleFlags;
};

export type RemuxedAudioTrackSamples = DemuxedAudioTrack & {
  samples: Mp4Sample[];
};

export type RemuxedVideoTrackSamples = DemuxedVideoTrack & {
  samples: Mp4Sample[];
};

export interface RemuxerResult {
  audio?: RemuxedTrack | undefined;
  video?: RemuxedTrack | undefined;
  text?: RemuxedUserdata | undefined;
  id3?: RemuxedMetadata | undefined;
  initSegment?: InitSegmentData | undefined;
  independent?: boolean | undefined;
}

export interface InitSegmentData {
  tracks?: TrackSet | undefined;
  initPTS: number | undefined;
  timescale: number | undefined;
  trackId: number | undefined;
}
