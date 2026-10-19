// CMCD mapping for Shaka requests (ADR-005 §2); loaded with Shaka only when CMCD is enabled.

import type { CmcdRequestInfo } from '@otter-player/media';
import type { ShakaRequestContext } from './shaka-types.js';

// shaka.net.NetworkingEngine.RequestType
const MANIFEST_REQUEST = 0;
const SEGMENT_REQUEST = 1;
const INIT_SEGMENT = 0; // shaka.net.NetworkingEngine.AdvancedRequestType.INIT_SEGMENT

/**
 * CMCD request description for a Shaka request, or undefined when it must not carry CMCD
 * (license / certificate / timing requests: DRM servers often reject unknown parameters).
 */
export function shakaCmcdRequest(type: number, url: string, context?: ShakaRequestContext): CmcdRequestInfo | undefined {
  if (type === MANIFEST_REQUEST) return { url, kind: 'manifest' };
  if (type !== SEGMENT_REQUEST) return undefined;
  if (context?.type === INIT_SEGMENT) return { url, kind: 'init' };
  const streamType = context?.stream?.type;
  const kind = streamType === 'video' ? 'video' : streamType === 'audio' ? 'audio' : streamType === 'text' ? 'caption' : 'other';
  const seg = context?.segment;
  const duration = seg?.startTime != null && seg.endTime != null ? seg.endTime - seg.startTime : undefined;
  const bandwidth = context?.stream?.bandwidth;
  return {
    url,
    kind,
    ...(duration !== undefined && duration > 0 ? { durationS: duration } : {}),
    ...(bandwidth !== undefined && bandwidth > 0 ? { bitrateBps: bandwidth } : {}),
  };
}
