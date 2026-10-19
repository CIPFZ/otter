// Entry of the hls.js L2 copy (Otter's own file): the MPEG-TS demuxer, the fMP4 remuxer and the
// shim types they are configured with. The pipeline wraps these (ADR-007 §2).

export { default as TSDemuxer } from './demux/tsdemuxer.js';
export { default as MP4Remuxer } from './remux/mp4-remuxer.js';
export { DEFAULT_DEMUX_CONFIG, ErrorDetails, ErrorTypes, Events, logger, type ChunkMetadata, type HlsConfig, type HlsEventEmitter, type TypeSupported } from './otter/shims.js';
export type { DemuxedAudioTrack, DemuxedVideoTrack, DemuxerResult } from './types/demuxer.js';
export type { RemuxerResult } from './types/remuxer.js';
