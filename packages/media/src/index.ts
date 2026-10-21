export type {
  BackendContext,
  BackendEvents,
  BackendFactory,
  BackendKind,
  MediaBackend,
  PlaybackSnapshot,
} from './backend.js';
export {
  createCapabilityDetector,
  DEFAULT_PROBE_CODECS,
  detectCapabilities,
  NO_CAPABILITIES,
  type Capabilities,
  type CapabilityDetector,
  type CapabilityProbeOptions,
  type CodecDecodingInfo,
} from './capabilities.js';
// Types only: the CMCD implementation is an on-demand chunk loaded by the session (ADR-004 §2).
export type {
  CmcdConfig,
  CmcdDecoration,
  CmcdDecorator,
  CmcdKeys,
  CmcdObjectKind,
  CmcdRequestInfo,
  CmcdState,
} from './cmcd.js';
export type { Decoder, DecoderConfig, DecoderInstance, EncodedChunk } from './decoder.js';
export type { DemuxAudioTrack, DemuxDownload, DemuxInfo, DemuxTrack, DemuxVideoTrack, DecodeSetup, PacketStream, PositionedStream } from './demux.js';
export { closeFrame, frameTransferables, i420Size, isI420, type DecodedFrame, type FrameSink, type I420Frame } from './frames.js';
export {
  bufferedEndAt,
  mediaElementError,
  observeMediaElement,
  type BackendEmit,
  type MediaElementObserver,
  type ObserveOptions,
} from './element.js';
export type { DemuxContext, Demuxer, Engine, EngineContext, EngineEvents, FormatPlugin } from './format.js';
export {
  createRouter,
  FALLBACK_CHAIN,
  stepLabel,
  type FallbackStep,
  type RouteDecision,
  type RoutePolicy,
  type Router,
  type RouterOptions,
} from './router.js';
export {
  createMediaPlugin,
  INITIAL_MEDIA_STATE,
  MEDIA_SLICE,
  type MediaActionMap,
  type MediaPlugin,
  type MediaPluginOptions,
  type MediaState,
} from './session.js';
export type { DrmConfig, KeySystem, LoadOptions, Mp4Rendition, SidecarTextTrack, Source } from './source.js';
export {
  EMPTY_TIME_RANGES,
  EMPTY_TRACKS,
  type AudioTrack,
  type BaseTrack,
  type InbandCue,
  type InbandCues,
  type MediaTrack,
  type TextTrackInfo,
  type TrackList,
  type VideoTrack,
} from './tracks.js';
export {
  DEFAULT_RECOVERY,
  createRetryBudget,
  createStallWatchdog,
  resolveRecovery,
  type RecoveryPolicy,
  type RetryBudget,
  type StallAction,
  type StallWatchdog,
} from './recovery.js';
export type { Thumbnail, ThumbnailProvider } from './thumbnails.js';
