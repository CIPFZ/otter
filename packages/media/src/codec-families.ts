// Video codec preference (SPEC §5.1, ADR-011 batch 3), the part every page carries: the four
// families, what they are probed with, and the contract with the engines. The ranking itself
// (codecs.ts) is an on-demand chunk the session loads alongside capability detection.

export type CodecFamily = 'av1' | 'hevc' | 'vp9' | 'h264';

/** What a family is probed with: a common 720p profile in fMP4 (what MSE engines append). */
export const FAMILY_PROBES: Readonly<Record<CodecFamily, string>> = {
  av1: 'video/mp4; codecs="av01.0.05M.08"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  vp9: 'video/mp4; codecs="vp09.00.31.08"',
  h264: 'video/mp4; codecs="avc1.640028"',
};

export type CodecCriterion = 'powerEfficient' | 'smooth' | 'order';

/** Host policy for ranking the supported families. */
export interface CodecPolicy {
  /**
   * Tie-break order, best first; families left out come after, in the default order.
   * Default AV1, HEVC, VP9, H.264 (newest, most efficient first).
   */
  readonly order?: readonly CodecFamily[];
  /** Criteria in turn; default power efficiency, then smoothness, then `order`. */
  readonly rank?: readonly CodecCriterion[];
}

/** Anything with codec strings: SPF / HLS variants, Shaka tracks, Otter VideoTracks. */
export interface CodecCarrier {
  readonly codecs?: string | readonly string[] | null | undefined;
  readonly videoCodec?: string | null | undefined;
  readonly codec?: string | null | undefined;
}

/**
 * What engines get (EngineContext.codecs): the ranking, and `pick`, which keeps the tracks of
 * the best-ranked family a stream offers and reports the choice (router.explain(), state.codec).
 */
export interface EngineCodecs {
  readonly order: readonly CodecFamily[];
  /** RFC 6381 sample entries of `order` (`av01`, `hvc1`, `hev1`, ...), for engines that prefer by prefix. */
  readonly entries: readonly string[];
  pick<T extends CodecCarrier>(tracks: readonly T[]): T[];
}

/** No ranking (nothing probed): every track stays. */
export const NO_CODEC_RANKING: EngineCodecs = { order: [], entries: [], pick: (tracks) => [...tracks] };

