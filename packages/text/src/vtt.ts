// WebVTT / SRT parsing through media-captions (L1, MIT, ADR-005 §4), loaded on first use. Only
// the parser and tokenizer are used; its HTML string renderer interpolates entity-decoded text and
// is unsafe for untrusted files (REUSE §4).

import type { VTTCue, VTTNode, VTTRegion } from 'media-captions';
import type { CueNode, CueNodeType, TextCue } from './cue.js';
import type { CueSettings, RegionSettings } from './layout.js';

export type SidecarFormat = 'vtt' | 'srt';

export interface ParsedCaptions {
  readonly cues: readonly TextCue[];
  /** Malformed blocks skipped by the parser. */
  readonly errors: number;
}

const BLOCK: Readonly<Record<string, CueNodeType>> = {
  b: 'b',
  i: 'i',
  u: 'u',
  ruby: 'ruby',
  rt: 'rt',
  c: 'c',
  v: 'v',
  lang: 'lang',
  timestamp: 'timestamp',
};

function toNodes(tokens: readonly VTTNode[]): CueNode[] {
  const out: CueNode[] = [];
  for (const t of tokens) {
    if (t.type === 'text') {
      out.push({ type: 'text', text: t.data });
      continue;
    }
    const type = BLOCK[t.type];
    const children = toNodes(t.children);
    // Unknown tags keep their text only.
    if (type === undefined) {
      out.push(...children);
      continue;
    }
    out.push({
      type,
      classes: (t.class ?? '').split(/\s+/).filter((c) => c !== ''),
      ...(t.type === 'v' ? { voice: t.voice } : {}),
      ...(t.type === 'lang' ? { lang: t.lang } : {}),
      ...(t.type === 'timestamp' ? { time: t.time } : {}),
      ...(t.color === undefined ? {} : { color: t.color }),
      ...(t.bgColor === undefined ? {} : { bgColor: t.bgColor }),
      children,
    });
  }
  return out;
}

const region = (r: VTTRegion | null): RegionSettings | null =>
  r === null
    ? null
    : {
        id: r.id,
        width: r.width,
        lines: r.lines,
        regionAnchorX: r.regionAnchorX,
        regionAnchorY: r.regionAnchorY,
        viewportAnchorX: r.viewportAnchorX,
        viewportAnchorY: r.viewportAnchorY,
        scroll: r.scroll,
      };

const settingsOf = (c: VTTCue): CueSettings => ({
  line: c.line,
  snapToLines: c.snapToLines,
  lineAlign: c.lineAlign,
  position: c.position,
  positionAlign: c.positionAlign,
  size: c.size,
  align: c.align,
  region: region(c.region),
});

/** Cue text with WebVTT markup (engine in-band cues) to nodes, same rules as sidecar files. */
export async function vttNodes(text: string): Promise<CueNode[]> {
  const { tokenizeVTTCue } = await import('media-captions');
  return toNodes(tokenizeVTTCue({ text } as VTTCue));
}

export async function parseCaptions(text: string, format: SidecarFormat = 'vtt', idPrefix = 'cue'): Promise<ParsedCaptions> {
  const { parseText, tokenizeVTTCue } = await import('media-captions');
  const result = await parseText(text, { type: format, strict: false });
  return {
    cues: result.cues.map((c, i) => ({
      // VTT cue identifiers are optional and not unique; the index is.
      id: `${idPrefix}:${i}`,
      startTime: c.startTime,
      endTime: c.endTime,
      nodes: toNodes(tokenizeVTTCue(c)),
      settings: settingsOf(c),
    })),
    errors: result.errors.length,
  };
}
