// One video codec family for Shaka (ADR-011 batch 3), loaded with the engine. DASH: the MPD's
// video Representations of the other families are removed before Shaka parses it (its TXml
// preprocessor hook), through the same `codecs.pick` the other engines use, so the choice and the
// families on offer reach router.explain(). Any manifest: `preferredVideo` lists the ranked
// sample entries, so Shaka's own codec chooser (HLS) agrees.

import type { EngineCodecs } from '@otter-player/media';

/** The part of shaka.extern.xml.Node the filter reads and edits. */
export interface TXmlNode {
  readonly tagName: string;
  readonly attributes: Record<string, string>;
  children: (TXmlNode | string)[];
}

const elements = (n: TXmlNode, tag: string): TXmlNode[] => n.children.filter((c): c is TXmlNode => typeof c !== 'string' && c.tagName === tag);

const isVideo = (set: TXmlNode, rep?: TXmlNode): boolean => {
  const type = set.attributes['contentType'] ?? set.attributes['mimeType'] ?? rep?.attributes['mimeType'] ?? '';
  return type.startsWith('video');
};

/** Removes the video Representations (and AdaptationSets left empty) of other codec families. */
export function filterMpd(mpd: TXmlNode, codecs: EngineCodecs): TXmlNode {
  const reps: { set: TXmlNode; rep: TXmlNode; codecs: string }[] = [];
  for (const period of elements(mpd, 'Period')) {
    for (const set of elements(period, 'AdaptationSet')) {
      for (const rep of elements(set, 'Representation')) {
        if (isVideo(set, rep)) reps.push({ set, rep, codecs: rep.attributes['codecs'] ?? set.attributes['codecs'] ?? '' });
      }
    }
  }
  if (reps.length === 0) return mpd;
  const keep = new Set(codecs.pick(reps).map((r) => r.rep));
  for (const { set, rep } of reps) if (!keep.has(rep)) set.children = set.children.filter((c) => c !== rep);
  for (const period of elements(mpd, 'Period')) {
    period.children = period.children.filter((c) => typeof c === 'string' || c.tagName !== 'AdaptationSet' || !isVideo(c) || elements(c, 'Representation').length > 0);
  }
  return mpd;
}

/** shaka.extern.VideoPreference entries for the ranked sample entries. */
export const preferredVideo = (codecs: EngineCodecs): Record<string, string>[] =>
  codecs.entries.map((codec) => ({ label: '', role: '', language: '', codec, hdrLevel: 'AUTO', layout: '' }));
