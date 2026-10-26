// Video codec ranking (SPEC §5.1, ADR-011 batch 3), an on-demand chunk: the four families a
// stream may offer side by side (AV1 / HEVC / VP9 / H.264), probed with
// MediaCapabilities.decodingInfo, ranked, and the choice among what a stream offers. Engines keep
// one family (switching families mid-stream needs changeType, off by default: SPEC §6.2). Every
// family's probe and the choice go to router.explain(). Imports nothing the entry imports.

import type { RouteStep } from '@otter-player/core';
import type { CodecDecodingInfo } from './capabilities.js';
import type { CodecCarrier, CodecCriterion, CodecFamily, CodecPolicy } from './codec-families.js';

export const CODEC_FAMILIES: readonly CodecFamily[] = ['av1', 'hevc', 'vp9', 'h264'];

/** RFC 6381 sample entries per family (Shaka / hls.js preferences are by prefix). */
export const FAMILY_ENTRIES: Readonly<Record<CodecFamily, readonly string[]>> = {
  av1: ['av01'],
  hevc: ['hvc1', 'hev1'],
  vp9: ['vp09'],
  h264: ['avc1', 'avc3'],
};

/** Family of a codec string (`avc1.64001f` -> h264), undefined for audio and others. */
export function codecFamily(codec: string): CodecFamily | undefined {
  const entry = codec.trim().slice(0, 4).toLowerCase();
  return CODEC_FAMILIES.find((f) => FAMILY_ENTRIES[f].includes(entry)) ?? (entry === 'vp9' ? 'vp9' : undefined);
}

export const DEFAULT_CODEC_RANK: readonly CodecCriterion[] = ['powerEfficient', 'smooth', 'order'];

export interface CodecRanking {
  /** Supported families, best first. */
  readonly order: readonly CodecFamily[];
  /** Their sample entries, in that order. */
  readonly entries: readonly string[];
  /** One step per family for router.explain(). */
  readonly steps: readonly RouteStep[];
}

const describe = (i: CodecDecodingInfo): string =>
  `${i.smooth ? 'smooth' : 'not smooth'}, ${i.powerEfficient ? 'power efficient' : 'not power efficient'}`;

/**
 * Ranks the families by their probe results. A user preference (`preferred`, persisted) comes
 * first among the supported families; then the host's criteria. Unsupported and `excluded` families
 * (no picture on this device, with why) are out.
 */
export function rankCodecs(
  probes: Readonly<Partial<Record<CodecFamily, CodecDecodingInfo>>>,
  policy: CodecPolicy = {},
  preferred: readonly CodecFamily[] | null = null,
  excluded: Readonly<Partial<Record<CodecFamily, string>>> = {},
): CodecRanking {
  const order = [...(policy.order ?? CODEC_FAMILIES), ...CODEC_FAMILIES];
  const rank = policy.rank ?? DEFAULT_CODEC_RANK;
  const info = (f: CodecFamily): CodecDecodingInfo => probes[f] ?? { supported: false, smooth: false, powerEfficient: false };
  const pos = (list: readonly CodecFamily[], f: CodecFamily): number => {
    const i = list.indexOf(f);
    return i < 0 ? list.length : i;
  };
  const supported = CODEC_FAMILIES.filter((f) => info(f).supported && excluded[f] === undefined);
  const ranked = [...supported].sort((a, b) => {
    if (preferred !== null && pos(preferred, a) !== pos(preferred, b)) return pos(preferred, a) - pos(preferred, b);
    for (const c of rank) {
      const d = c === 'order' ? pos(order, a) - pos(order, b) : Number(info(b)[c]) - Number(info(a)[c]);
      if (d !== 0) return d;
    }
    return pos(order, a) - pos(order, b);
  });
  const by = preferred === null ? rank.join(' > ') : `user preference ${preferred.join(' > ')}, then ${rank.join(' > ')}`;
  const steps: RouteStep[] = CODEC_FAMILIES.map((f) => {
    const i = info(f);
    const at = ranked.indexOf(f);
    const why = excluded[f];
    if (i.supported && why !== undefined) return { candidate: `codec ${f}`, outcome: 'rejected', reason: `decodingInfo: supported, excluded: ${why}` };
    return i.supported
      ? { candidate: `codec ${f}`, outcome: 'selected', reason: `decodingInfo: supported, ${describe(i)}; rank ${at + 1} (${by})` }
      : { candidate: `codec ${f}`, outcome: 'rejected', reason: 'decodingInfo: not supported' };
  });
  return { order: ranked, entries: ranked.flatMap((f) => FAMILY_ENTRIES[f]), steps };
}

/** Video codec strings of a track: `codecs` (string or list), or Shaka's `videoCodec`. */
const videoCodecs = (t: CodecCarrier): string[] => {
  const raw = t.videoCodec ?? t.codecs ?? t.codec ?? [];
  return (typeof raw === 'string' ? raw.split(',') : [...raw]).filter((c) => codecFamily(c) !== undefined);
};

export interface CodecChoice {
  /** The family kept, undefined when the stream names none (all tracks kept). */
  readonly family: CodecFamily | undefined;
  /** Families the stream offers, in its order. */
  readonly offered: readonly CodecFamily[];
  readonly reason: string;
}

/**
 * The family to play from what a stream offers: the best-ranked one present. Tracks without a
 * known family (audio-only, unlabelled) stay; a stream offering none of the ranked families keeps
 * everything (the engine's own support check decides).
 */
export function chooseCodec(order: readonly CodecFamily[], tracks: readonly CodecCarrier[]): CodecChoice {
  const offered = [...new Set(tracks.flatMap((t) => videoCodecs(t).map((c) => codecFamily(c) as CodecFamily)))];
  const family = order.find((f) => offered.includes(f));
  const reason =
    offered.length === 0
      ? 'stream names no video codec'
      : family === undefined
        ? `stream offers ${offered.join(', ')}, none probed as supported; left to the engine`
        : offered.length === 1
          ? `stream offers ${family} only`
          : `stream offers ${offered.join(', ')}: ${family} ranks first`;
  return { family, offered, reason };
}

/** `tracks` of the chosen family (and those without one). */
export function keepFamily<T extends CodecCarrier>(tracks: readonly T[], family: CodecFamily | undefined): T[] {
  if (family === undefined) return [...tracks];
  return tracks.filter((t) => {
    const fams = videoCodecs(t).map(codecFamily);
    return fams.length === 0 || fams.includes(family);
  });
}
