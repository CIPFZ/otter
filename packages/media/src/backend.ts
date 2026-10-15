// MediaBackend (SPEC §5): the only surface core and UI see of native / MSE / WebCodecs playback.

import type { OtterError, Unsubscribe } from '@otter-player/core';
import type { LoadOptions, Source } from './source.js';
import type { TrackList } from './tracks.js';

export type BackendKind = 'native' | 'mse' | 'webcodecs';

export interface BackendEvents {
  'tracks-change': TrackList;
  'quality-change': { readonly id: string; readonly auto: boolean };
  'buffered-change': { readonly buffered: TimeRanges };
  'latency-change': { readonly latency: number };
  waiting: { readonly position: number };
  stalled: { readonly position: number };
  ended: { readonly position: number };
  error: OtterError;
}

export interface MediaBackend {
  readonly kind: BackendKind;
  attach(target: HTMLMediaElement | HTMLCanvasElement): void;
  load(source: Source, opts: LoadOptions): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(t: number): void;
  /** video / audio / text, unified model */
  readonly tracks: TrackList;
  selectQuality(id: string | 'auto'): void;
  readonly buffered: TimeRanges;
  /** Seconds behind the live edge, live sources only. */
  readonly latency?: number;
  on<E extends keyof BackendEvents>(e: E, h: (p: BackendEvents[E]) => void): Unsubscribe;
  destroy(): void;
}
