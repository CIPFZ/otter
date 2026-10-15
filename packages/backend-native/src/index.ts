// Native <video src> backend (SPEC §6.1). M0 empty implementation: every operation reports `notImplemented`.

import { notImplemented, type Unsubscribe } from '@otter-player/core';
import { EMPTY_TIME_RANGES, EMPTY_TRACKS, type MediaBackend } from '@otter-player/media';

export interface NativeBackendOptions {
  /** Set `disableRemotePlayback` instead of offering AirPlay. */
  readonly disableRemotePlayback?: boolean;
}

const noop: Unsubscribe = () => undefined;

export function createNativeBackend(_options: NativeBackendOptions = {}): MediaBackend {
  const fail = (method: string): Error => notImplemented(`@otter-player/backend-native ${method}`);
  return {
    kind: 'native',
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
