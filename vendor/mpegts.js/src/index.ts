// Entry of the mpegts.js L2 copy (Otter's own file): the FLV demuxer and its error codes. The
// pipeline maps its tracks onto hls.js' sample model and remuxes with the hls.js copy (ADR-007 §2).

export { default as FLVDemuxer } from './demux/flv-demuxer.js';
export { default as DemuxErrors } from './demux/demux-errors.js';
export type { FlvAudioSample, FlvTrack, FlvTrackMeta, FlvVideoSample } from './demux/flv-demuxer.js';
