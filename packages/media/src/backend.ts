// MediaBackend (SPEC §5, ADR-003 §2): the only code that touches the <video> element or canvas.
// The playback session (media plugin) drives backends through this interface and listens to
// BackendEvents; UI never sees a backend.

import type { OtterError, QoeHook, Unsubscribe } from '@otter-player/core';
import type { Capabilities } from './capabilities.js';
import type { CmcdDecorator } from './cmcd.js';
import type { Decoder } from './decoder.js';
import type { FormatPlugin } from './format.js';
import type { FallbackStep } from './router.js';
import type { LoadOptions, Source } from './source.js';
import type { ThumbnailProvider } from './thumbnails.js';
import type { InbandCues, TrackList } from './tracks.js';

export type BackendKind = 'native' | 'mse' | 'webcodecs';

/** Playback state mirrored into the store. Times in seconds. */
export interface PlaybackSnapshot {
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly waiting: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly bufferedEnd: number;
  /**
   * The range the user can seek in (HTMLMediaElement.seekable, first start to last end): VOD
   * 0..duration; live, the DVR window (engines set it with setLiveSeekableRange); null without one.
   */
  readonly seekableStart: number | null;
  readonly seekableEnd: number | null;
  readonly volume: number;
  readonly muted: boolean;
  readonly playbackRate: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  /** HTMLMediaElement.readyState semantics (0..4). */
  readonly readyState: number;
}

export interface BackendEvents {
  'playback-change': Partial<PlaybackSnapshot>;
  'tracks-change': TrackList;
  'quality-change': { readonly id: string; readonly auto: boolean; readonly reason: string };
  'buffered-change': { readonly buffered: TimeRanges };
  'latency-change': { readonly latency: number; readonly target?: number };
  /** First decoded frame is available (TTFF). */
  'first-frame': { readonly at: number };
  /** First media segment finished loading. */
  'first-segment': { readonly at: number };
  bandwidth: { readonly estimate: number; readonly fast: number; readonly slow: number; readonly estimated?: boolean };
  'dropped-frames': { readonly dropped: number; readonly total: number };
  /** MMS / AirPlay handling decided by the backend (ADR-003 §5); annotated onto the route. */
  'remote-playback': { readonly mms: boolean; readonly remotePlayback: 'enabled' | 'disabled'; readonly reason: string };
  /**
   * A detail of how the backend runs this route (decoder build, SIMD, threads), annotated onto it.
   * With `candidate` / `outcome`: a step the backend took itself, e.g. a runtime fallback from the
   * WebCodecs decoder to the WASM one inside the same backend; `outcome: 'selected'` with another
   * candidate makes it the route's backend label.
   */
  'route-detail': { readonly reason: string; readonly candidate?: string; readonly outcome?: 'selected' | 'failed' };
  waiting: { readonly position: number };
  stalled: { readonly position: number };
  ended: { readonly position: number };
  /** In-band cues of the selected text track. */
  'text-cues': InbandCues;
  error: OtterError;
}

export interface MediaBackend {
  readonly kind: BackendKind;
  attach(target: HTMLMediaElement | HTMLCanvasElement): void;
  load(source: Source, opts: LoadOptions): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(t: number): void;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  setPlaybackRate(r: number): void;
  /** video / audio / text, unified model */
  readonly tracks: TrackList;
  selectQuality(id: string | 'auto'): void;
  /** Selects the in-band text track whose cues are delivered as `text-cues`; null for none. */
  selectTextTrack?(id: string | null): void;
  selectAudioTrack?(id: string): void;
  /** Live: back to the live edge. */
  seekToLive?(): void;
  /** The engine's seek-preview pictures (Engine.thumbnails), null without. */
  thumbnails?(): ThumbnailProvider | null;
  readonly buffered: TimeRanges;
  /** Seconds behind the live edge, live sources only. */
  readonly latency?: number | undefined;
  on<E extends keyof BackendEvents>(e: E, h: (p: BackendEvents[E]) => void): Unsubscribe;
  destroy(): void;
}

/** Everything a backend instance needs from one routing decision. */
export interface BackendContext {
  readonly format: FormatPlugin;
  readonly step: FallbackStep;
  readonly caps: Capabilities;
  readonly qoe: QoeHook;
  /** Present when CMCD is enabled (ADR-005 §2); element-only backends (native) cannot use it. */
  readonly cmcd?: CmcdDecorator;
  /** Decoder plugins the host registered; the WebCodecs backend picks one by `step.decoder`. */
  readonly decoders?: readonly Decoder[];
}

export interface BackendFactory {
  readonly kind: BackendKind;
  create(ctx: BackendContext): MediaBackend;
}
