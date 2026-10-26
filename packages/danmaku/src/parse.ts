// Comment lists for the danmaku engine, an on-demand chunk loaded by `load-danmaku`: B站 XML
// (CommentCoreLibrary's parser, vendor/), and JSON in three shapes: CCL's common list
// ({stime ms, mode, size, color, text}), B站's DanmakuElem as JSON ({progress ms, mode, fontsize,
// color, content}) with or without a {data: [...]} / {elems: [...]} wrapper, and DPlayer's
// [[time s, type 0/1/2, color, author, text]].

import type { DanmakuInput } from './settings.js';
import { parseCommon, parseXml, type ParsedComment } from './vendor/CommentCoreLibrary/bilibili.js';
import type { Mode } from './vendor/danmaku/allocate.js';

export interface LoadedComments {
  readonly comments: DanmakuInput[];
  readonly skipped: number;
}

/** B站 mode numbers: 1-3 scrolling, 4 bottom, 5 top, 6 reverse. */
const MODES: Readonly<Record<number, Mode>> = { 1: 'rtl', 2: 'rtl', 3: 'rtl', 4: 'bottom', 5: 'top', 6: 'ltr' };

const fromParsed = (c: ParsedComment): DanmakuInput => ({ time: c.time, text: c.text, mode: MODES[c.mode] ?? 'rtl', color: c.color, size: c.size });

/** One JSON element in any of the three shapes, or null. */
function fromJson(e: unknown): DanmakuInput | null {
  if (Array.isArray(e)) {
    // DPlayer: [time, type (0 right-to-left, 1 top, 2 bottom), color, author, text].
    const [time, type, color, , text] = e as unknown[];
    if (typeof time !== 'number' || typeof text !== 'string') return null;
    const mode: Mode = type === 1 ? 'top' : type === 2 ? 'bottom' : 'rtl';
    return { time, text, mode, color: typeof color === 'number' ? color & 0xffffff : 0xffffff };
  }
  if (typeof e !== 'object' || e === null) return null;
  const o = e as Record<string, unknown>;
  if (typeof o['progress'] === 'number' || typeof o['content'] === 'string') {
    // B站 DanmakuElem (protobuf decoded to JSON).
    const mode = MODES[typeof o['mode'] === 'number' ? o['mode'] : 1];
    if (mode === undefined || typeof o['content'] !== 'string') return null;
    return {
      time: (typeof o['progress'] === 'number' ? o['progress'] : 0) / 1000,
      text: o['content'],
      mode,
      color: typeof o['color'] === 'number' ? o['color'] & 0xffffff : 0xffffff,
      size: typeof o['fontsize'] === 'number' && o['fontsize'] > 0 ? o['fontsize'] : 25,
    };
  }
  const c = parseCommon(o);
  return c === null ? null : fromParsed(c);
}

/** Comments from an XML or JSON document. */
export function parseComments(text: string): LoadedComments {
  const t = text.trimStart();
  if (t.startsWith('<')) {
    const r = parseXml(t);
    return { comments: r.comments.map(fromParsed), skipped: r.skipped };
  }
  const json: unknown = JSON.parse(t);
  const list = Array.isArray(json) ? json : ((json as { data?: unknown; elems?: unknown }).data ?? (json as { elems?: unknown }).elems);
  if (!Array.isArray(list)) throw new Error('danmaku JSON: no comment list');
  const comments: DanmakuInput[] = [];
  let skipped = 0;
  for (const e of list) {
    const c = fromJson(e);
    if (c === null) skipped++;
    else comments.push(c);
  }
  return { comments, skipped };
}

export async function loadComments(req: { readonly url?: string; readonly text?: string }, doFetch: (url: string) => Promise<Response>): Promise<LoadedComments> {
  if (req.text !== undefined) return parseComments(req.text);
  const res = await doFetch(req.url as string);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseComments(await res.text());
}
