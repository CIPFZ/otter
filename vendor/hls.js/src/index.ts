// Entry of the hls.js L2 copy (Otter's own file): the MPEG-TS demuxer, the fMP4 remuxer and the
// shim types they are configured with. The pipeline wraps these (ADR-007 §2).

export { default as TSDemuxer } from './demux/tsdemuxer.js';
export { default as MP4Remuxer } from './remux/mp4-remuxer.js';
export { default as AvcVideoParser } from './demux/video/avc-video-parser.js';
export { default as HevcVideoParser } from './demux/video/hevc-video-parser.js';
export { DEFAULT_DEMUX_CONFIG, ErrorDetails, ErrorTypes, Events, logger, type ChunkMetadata, type HlsConfig, type HlsEventEmitter, type TypeSupported } from './otter/shims.js';
export { parseSEIMessageFromNALu } from './utils/mp4-tools.js';
export type { DemuxedAudioTrack, DemuxedUserdataTrack, DemuxedVideoTrack, DemuxerResult, UserdataSample } from './types/demuxer.js';
export type { RemuxerResult } from './types/remuxer.js';
