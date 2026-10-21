// FormatPlugin and Engine (SPEC §5, ADR-003 §3). A FormatPlugin scores a source, declares which
// backends it can feed and produces the Engine (engine adapter or, from M3, the own pipeline).

import type { OtterError, QoeHook, Unsubscribe } from '@otter-player/core';
import type { BackendKind } from './backend.js';
import type { Capabilities } from './capabilities.js';
import type { CmcdDecorator } from './cmcd.js';
import type { DemuxDownload, DemuxInfo, PacketStream, PositionedStream } from './demux.js';
import type { LoadOptions, Source } from './source.js';
import type { ThumbnailProvider } from './thumbnails.js';
import type { InbandCues, TrackList } from './tracks.js';

export interface EngineContext {
  readonly source: Source;
  readonly options: LoadOptions;
  readonly caps: Capabilities;
  readonly backend: BackendKind;
  readonly qoe: QoeHook;
  /** Element the engine attaches its MediaSource to (engine adapters own MSE in M1). */
  readonly media: HTMLMediaElement;
  /** Use ManagedMediaSource instead of MediaSource (decided by backend-mse, ADR-003 §5). */
  readonly mms: boolean;
  /** Allow cross-codec quality switches through `changeType` (SPEC §6.2). */
  readonly allowCodecSwitch: boolean;
  /** CMCD request decorator; engines apply it in their request hooks (ADR-005 §2). */
  readonly cmcd?: CmcdDecorator;
}

export interface EngineEvents {
  'tracks-change': TrackList;
  'quality-change': { readonly id: string; readonly auto: boolean; readonly reason: string };
  'latency-change': { readonly latency: number; readonly target?: number };
  'first-segment': { readonly at: number };
  bandwidth: { readonly estimate: number; readonly fast: number; readonly slow: number; readonly estimated?: boolean };
  /** Cues of the selected in-band text track (ADR-005 §4). */
  'text-cues': InbandCues;
  /** `fatal` errors make the session fall back to the next backend. */
  error: OtterError;
}

export interface Engine {
  readonly formatId: string;
  readonly tracks: TrackList;
  readonly latency?: number | undefined;
  /** Whether the engine actually uses ManagedMediaSource; known once `load()` resolved. */
  readonly mms: boolean;
  /** Loads the engine library (dynamic import) and the manifest; resolves once tracks are known. */
  load(): Promise<void>;
  selectQuality(id: string | 'auto'): void;
  /** Enables delivery of one in-band text track's cues (`text-cues`), null for none. */
  selectTextTrack?(id: string | null): void;
  /** Switches the audio rendition (language / description track); ABR keeps choosing video. */
  selectAudioTrack?(id: string): void;
  /** Live: jump to the engine's live position (back to live, ADR-007 §3). */
  seekToLive?(): void;
  /** Seek-preview pictures from the stream itself (HLS I-frame playlists), null without. */
  thumbnails?(): ThumbnailProvider | null;
  on<E extends keyof EngineEvents>(e: E, h: (p: EngineEvents[E]) => void): Unsubscribe;
  destroy(): void;
}

/** Everything a format needs to demux a source for the WebCodecs backend (ADR-008 §2). */
export interface DemuxContext {
  readonly source: Source;
  readonly options: LoadOptions;
  readonly caps: Capabilities;
  readonly qoe: QoeHook;
  /** Aborted when the backend is torn down; implementations stop reading. */
  readonly signal: AbortSignal;
}

/**
 * A source opened for the WebCodecs path: tracks in, encoded packets out. `seek` restarts a
 * track at the last keyframe at or before the requested time, in decode order.
 */
export interface Demuxer {
  readonly info: DemuxInfo;
  /** Packets from the start (time 0), in decode order. */
  packets(track: 'video' | 'audio'): PacketStream;
  /** Packets from the last keyframe at or before `time`, in decode order. */
  seek(track: 'video' | 'audio', time: number): Promise<PacketStream>;
  /**
   * Packets of video rendition `id` (one of `info.videoTracks`) from its keyframe at or before
   * `time` (`edge: 'before'`) or at or after it (`'after'`, for a seamless quality switch);
   * null when there is none.
   */
  openVideo?(id: number, time: number, edge: 'before' | 'after'): Promise<PositionedStream | null>;
  /** Media downloads as they finish (URL sources), for ABR. */
  onDownload?(h: (d: DemuxDownload) => void): Unsubscribe;
  destroy(): void;
}

/** Everything a format needs to open a live MediaStream for the native backend (ADR-008 §8). */
export interface StreamContext {
  readonly source: Source;
  readonly options: LoadOptions;
  readonly qoe: QoeHook;
  /** Aborted when the backend is torn down; implementations stop connecting. */
  readonly signal: AbortSignal;
}

/** A connected MediaStream (WebRTC) the native backend plays through `srcObject`. */
export interface StreamSession {
  readonly stream: MediaStream;
  /** Seconds from capture to display where the transport measures it (WebRTC stats), else undefined. */
  readonly latency: number | undefined;
  /** Fatal errors after the stream started (the connection failed for good). */
  onError(h: (e: OtterError) => void): Unsubscribe;
  destroy(): void;
}

export interface FormatPlugin {
  readonly id: string;
  /** Confidence 0..1 that this plugin can play `source`. */
  probe(source: Source, caps: Capabilities): number;
  /** Backends this format can feed for `source`, in no particular order. */
  backends(source: Source, caps: Capabilities): readonly BackendKind[];
  createEngine(ctx: EngineContext): Engine;
  /**
   * Demuxer for the WebCodecs backend (ADR-008 §2), when `backends()` lists `webcodecs`. Called
   * instead of `createEngine` for that backend; the module it needs loads inside it.
   */
  createDemuxer?(ctx: DemuxContext): Promise<Demuxer>;
  /**
   * A connected MediaStream for the native backend instead of `src` (format-whep, ADR-008 §8).
   * Rejects with an OtterError (e.g. `iceFailed`, fatal) when it cannot connect.
   */
  openStream?(ctx: StreamContext): Promise<StreamSession>;
}
