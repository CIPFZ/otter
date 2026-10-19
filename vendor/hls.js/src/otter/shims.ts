// Otter shims for the hls.js modules the vendored demux / remux code used to import (ADR-007 §1:
// no event bus, no hls.js config object). Same names and shapes as upstream, Otter's own code.

/** hls.js build-time defines, fixed for Otter: HEVC in TS on, I-frame playback off. */
export const USE_M2TS_ADVANCED_CODECS: boolean = true;
export const USE_IFRAMES: boolean = false;

/** hls.js ErrorTypes / ErrorDetails values the copied code emits. */
export const ErrorTypes = { MEDIA_ERROR: 'mediaError', MUX_ERROR: 'muxError' } as const;
export const ErrorDetails = { FRAG_PARSING_ERROR: 'fragParsingError', REMUX_ALLOC_ERROR: 'remuxAllocError' } as const;

export const Events = { ERROR: 'hlsError' } as const;

/** Payload of Events.ERROR (hls.js ErrorData subset; extra fields such as levelRetry pass through). */
export interface ErrorEventData {
  readonly type: string;
  readonly details: string;
  readonly fatal: boolean;
  readonly error?: Error | undefined;
  readonly reason?: string | undefined;
  readonly [extra: string]: unknown;
}

/** What the demuxer / remuxer report through; the pipeline turns it into OtterErrors. */
export interface HlsEventEmitter {
  emit(event: string, name: string, data: ErrorEventData): boolean;
  removeAllListeners?(): void;
}

/** The HlsConfig fields the copied code reads, with hls.js' defaults in DEFAULT_DEMUX_CONFIG. */
export interface HlsConfig {
  readonly forceKeyFrameOnDiscontinuity: boolean;
  readonly handleMpegTsVideoIntegrityErrors: 'process' | 'skip';
  readonly maxAudioFramesDrift: number;
  readonly maxBufferHole: number;
  readonly progressive: boolean;
  readonly stretchShortVideoTrack: boolean;
  readonly enableEmsgKLVMetadata: boolean;
}

export const DEFAULT_DEMUX_CONFIG: HlsConfig = {
  forceKeyFrameOnDiscontinuity: true,
  handleMpegTsVideoIntegrityErrors: 'process',
  maxAudioFramesDrift: 1,
  maxBufferHole: 0.1,
  progressive: true,
  stretchShortVideoTrack: false,
  enableEmsgKLVMetadata: false,
};

/** MPEG audio types MSE accepts in fMP4 (hls.js utils/codecs TypeSupported). */
export interface TypeSupported {
  mpeg: boolean;
  mp3: boolean;
  ac3: boolean;
}

export type SourceBufferName = 'video' | 'audio' | 'audiovideo';

export const PlaylistLevelType = { MAIN: 'main', AUDIO: 'audio', SUBTITLE: 'subtitle' } as const;
export type PlaylistLevelType = (typeof PlaylistLevelType)[keyof typeof PlaylistLevelType];

/** Per-chunk context (hls.js ChunkMetadata): only the fields the copied code reads. */
export interface ChunkMetadata {
  readonly sn: number;
  readonly iframe: boolean;
  readonly duration: number;
}

export interface TrackSet {
  audio?: RemuxTrack | undefined;
  video?: RemuxTrack | undefined;
  audiovideo?: RemuxTrack | undefined;
}

export interface RemuxTrack {
  id: 'audio' | 'main';
  container: string;
  codec?: string | undefined;
  supplemental?: string | undefined;
  levelCodec?: string | undefined;
  initSegment?: Uint8Array<ArrayBuffer> | undefined;
  metadata?: { channelCount?: number | undefined; width?: number; height?: number };
}

/** SAMPLE-AES is not supported by the Otter pipeline (streams stay on the hls.js adapter). */
export type DecryptData = never;

export type ILogFunction = (...args: unknown[]) => void;
export interface ILogger {
  trace: ILogFunction;
  debug: ILogFunction;
  log: ILogFunction;
  warn: ILogFunction;
  info: ILogFunction;
  error: ILogFunction;
}

const noop: ILogFunction = () => undefined;

/** Silent by default; the pipeline can pass a console-backed logger for debugging. */
export const logger: ILogger = { trace: noop, debug: noop, log: noop, warn: noop, info: noop, error: noop };

export class Logger implements ILogger {
  trace: ILogFunction;
  debug: ILogFunction;
  log: ILogFunction;
  warn: ILogFunction;
  info: ILogFunction;
  error: ILogFunction;
  constructor(label: string, base: ILogger) {
    const lb = `[${label}]:`;
    this.trace = noop;
    this.debug = base.debug.bind(null, lb);
    this.log = base.log.bind(null, lb);
    this.warn = base.warn.bind(null, lb);
    this.info = base.info.bind(null, lb);
    this.error = base.error.bind(null, lb);
  }
}
