// IMSC1 / TTML through imscJS (L1, BSD-2, ADR-005 §4), loaded on first use. The document is split
// at its media time events; each interval becomes one TextCue whose `paint` renders the ISD with
// imscJS (imscJS does its own region layout, so these cues bypass the WebVTT layout).

// No value imports from the entry's modules: a shared module would turn this lazy chunk into an
// eagerly initialised one in bundlers without code splitting.
import type { CueSettings } from './layout.js';
import type { CueNode, TextCue } from './cue.js';

interface ImscDoc {
  getMediaTimeEvents(): number[];
}
interface Isd {
  readonly contents: readonly IsdElement[];
}
interface IsdElement {
  readonly kind: string;
  readonly text?: string;
  readonly contents?: readonly IsdElement[];
}
interface Imsc {
  fromXML(xml: string, errorHandler?: object): ImscDoc | null;
  generateISD(doc: ImscDoc, offset: number, errorHandler?: object): Isd;
  renderHTML(isd: Isd, element: HTMLElement, imgResolver: null, height: number, width: number): unknown;
}

const textOf = (e: IsdElement): string =>
  e.kind === 'span' && e.text !== undefined ? e.text : e.kind === 'br' ? '\n' : (e.contents ?? []).map(textOf).join(e.kind === 'p' ? '' : '\n');

export async function parseTtml(xml: string, settings: CueSettings, idPrefix = 'ttml'): Promise<TextCue[]> {
  // CommonJS module: the namespace or its default, depending on the bundler's interop.
  const mod = (await import('imsc')) as unknown as Imsc & { default?: Imsc };
  const imsc = typeof mod.fromXML === 'function' ? mod : (mod.default as Imsc);
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, fatal: (msg: string) => { throw new Error(msg); } };
  const doc = imsc.fromXML(xml, quiet);
  if (doc === null) return [];
  const events = doc.getMediaTimeEvents();
  const cues: TextCue[] = [];
  for (let i = 0; i < events.length; i++) {
    const start = events[i] as number;
    const end = events[i + 1] ?? Number.POSITIVE_INFINITY;
    if (end <= start) continue;
    const isd = imsc.generateISD(doc, start, quiet);
    const text = isd.contents.map(textOf).join('\n').trim();
    if (text === '') continue;
    const nodes: CueNode[] = [{ type: 'text', text }];
    cues.push({
      id: `${idPrefix}:${i}`,
      startTime: start,
      endTime: end,
      nodes,
      settings,
      paint: (into, width, height) => {
        into.replaceChildren();
        imsc.renderHTML(isd, into, null, height, width);
      },
    });
  }
  return cues;
}
