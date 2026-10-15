// ManagedMediaSource and AirPlay preconditions (ADR-003 §5, RESEARCH §1): on iPhone, MMS refuses to
// start unless the element either offers an AirPlay alternate <source> or sets
// disableRemotePlayback. Applied uniformly here so every engine behaves the same.

import type { Source } from '@otter-player/media';
import { addSource, getMediaSource, isManagedMediaSource } from './vendor/hls.js/mediasource.js';

export const HLS_MIME = 'application/vnd.apple.mpegurl';

/** Same rule as hls.js: MMS when preferred and available, or when it is the only MediaSource. */
export function useManagedMediaSource(preferManagedMediaSource: boolean): boolean {
  return isManagedMediaSource(getMediaSource(preferManagedMediaSource));
}

/** AirPlay can play an HLS URL directly: the explicit alternate, else the source itself if HLS. */
export function airPlayAlternate(source: Source): string | undefined {
  if (source.airplaySrc !== undefined) return source.airplaySrc;
  if (typeof source.src !== 'string') return undefined;
  const hls = source.type?.toLowerCase().includes('mpegurl') === true || /\.m3u8(\?|#|$)/i.test(source.src);
  return hls ? source.src : undefined;
}

/** Before the engine attaches: without an alternate, remote playback must be off for MMS to open. */
export function prepareRemotePlayback(media: HTMLMediaElement, mms: boolean, alternate: string | undefined): void {
  if (mms && alternate === undefined) media.disableRemotePlayback = true;
}

export interface RemotePlaybackResult {
  readonly remotePlayback: 'enabled' | 'disabled';
  readonly reason: string;
  /** The <source> we appended, removed again on destroy. */
  readonly added: HTMLSourceElement | undefined;
}

/**
 * After the engine attached: engines that strip <source> children and force
 * disableRemotePlayback (hls.js does) get the AirPlay alternate appended after the MMS source.
 * An alternate the engine added itself (Shaka does for HLS) is reused.
 */
export function finishRemotePlayback(media: HTMLMediaElement, mms: boolean, alternate: string | undefined): RemotePlaybackResult {
  if (!mms) {
    return {
      remotePlayback: media.disableRemotePlayback ? 'disabled' : 'enabled',
      reason: 'mse: MediaSource, remote playback untouched',
      added: undefined,
    };
  }
  if (alternate === undefined) {
    media.disableRemotePlayback = true;
    return { remotePlayback: 'disabled', reason: 'mms: no AirPlay alternate, disableRemotePlayback', added: undefined };
  }
  const existing = Array.from(media.querySelectorAll('source')).some(
    (s) => s.getAttribute('src') === alternate || s.type.toLowerCase().includes('mpegurl'),
  );
  const added = existing ? undefined : addSource(media, alternate, HLS_MIME);
  media.disableRemotePlayback = false;
  return { remotePlayback: 'enabled', reason: 'mms: AirPlay alternate source', added };
}
