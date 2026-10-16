// WebCodecs backend (SPEC §6.3). M0 empty implementation: every operation reports `notImplemented`.

import { notImplemented, type Unsubscribe } from '@otter-player/core';
import { EMPTY_TIME_RANGES, EMPTY_TRACKS, type BackendFactory, type MediaBackend } from '@otter-player/media';

export interface WebCodecsBackendOptions {
  /** Upper bound on concurrently decoding instances sharing the Worker pool (SPEC §6.3). */
  readonly maxConcurrentDecoders?: number;
}

const noop: Unsubscribe = () => undefined;

export function createWebCodecsBackend(_options: WebCodecsBackendOptions = {}): MediaBackend {
  const fail = (method: string): Error => notImplemented(`@otter-player/backend-webcodecs ${method}`);
  return {
    kind: 'webcodecs',
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
    setVolume() {
      throw fail('setVolume');
    },
    setMuted() {
      throw fail('setMuted');
    },
    setPlaybackRate() {
      throw fail('setPlaybackRate');
    },
    selectQuality() {
      throw fail('selectQuality');
    },
    on: () => noop,
    destroy: () => undefined,
  };
}

export function createWebCodecsBackendFactory(options: WebCodecsBackendOptions = {}): BackendFactory {
  return { kind: 'webcodecs', create: () => createWebCodecsBackend(options) };
}
