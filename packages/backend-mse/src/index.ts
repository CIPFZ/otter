// MSE / ManagedMediaSource backend (SPEC §6.2). M0 empty implementation: every operation reports `notImplemented`.

import { notImplemented, type Unsubscribe } from '@otter-player/core';
import { EMPTY_TIME_RANGES, EMPTY_TRACKS, type MediaBackend } from '@otter-player/media';

export interface MseBackendOptions {
  /** Use ManagedMediaSource when both MMS and MSE exist (SPEC §6.2). */
  readonly preferManagedMediaSource?: boolean;
  /** Allow cross-codec quality switches via `changeType`; default stays within one codec family. */
  readonly allowCodecSwitch?: boolean;
}

const noop: Unsubscribe = () => undefined;

export function createMseBackend(_options: MseBackendOptions = {}): MediaBackend {
  const fail = (method: string): Error => notImplemented(`@otter-player/backend-mse ${method}`);
  return {
    kind: 'mse',
    tracks: EMPTY_TRACKS,
    buffered: EMPTY_TIME_RANGES,
    attach() {
      throw fail('attach');
    },
    load: () => Promise.reject(fail('load')),
    play: () => Promise.reject(fail('play')),
    pause() {
      throw fail('pause');
    },
    seek() {
      throw fail('seek');
    },
    selectQuality() {
      throw fail('selectQuality');
    },
    on: () => noop,
    destroy: () => undefined,
  };
}
