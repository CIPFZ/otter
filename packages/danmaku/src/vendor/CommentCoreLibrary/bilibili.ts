// Derived from CommentCoreLibrary@bc1109997a980f1f8ff2681759925a7ce6729478 src/parsers/BilibiliFormat.js, MIT
// Derived from CommentCoreLibrary@bc1109997a980f1f8ff2681759925a7ce6729478 src/parsers/CommonDanmakuFormat.js, MIT
//
// Copyright (c) 2017 Jim Chen. MIT License. B站 comment lists: the XML of `<d p="time,mode,size,
// color,date,pool,hash,dbid">text</d>` elements, and CCL's common JSON list. Modes 1-6 only
// (scrolling, bottom, top, reverse); advanced (7), code (8) and BAS (9) comments are counted and
// skipped. Local changes are listed in ./UPSTREAM.json.

export interface ParsedComment {
  /** Seconds. */
  readonly time: number;
  /** B站 mode: 1-3 scrolling, 4 bottom, 5 top, 6 reverse. */
  readonly mode: number;
  /** Font size, px (B站: 18 small, 25 standard, 36 large). */
  readonly size: number;
  /** 0xRRGGBB. */
  readonly color: number;
  readonly text: string;
  readonly pool: number;
  readonly id?: string;
}

export interface ParseResult {
  readonly comments: ParsedComment[];
  /** Elements that were not comments of the supported modes (advanced, code, malformed). */
  readonly skipped: number;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** XML character and the five predefined entity references. */
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] as string),
  );

/** Upstream's text normalisation: "/n", "\n" escapes and CRLF to newlines, ■ to █. */
const normalise = (text: string): string => text.replace(/(\/n|\\n|\n|\r\n)/g, '\n').replace(/■/g, '█');

/** One `p` attribute and text, as upstream's XMLParser.parseOne (modes 1-6). */
export function parseOne(p: string, text: string): ParsedComment | null {
  const params = p.split(',');
  const mode = parseInt(params[1] ?? '', 10);
  const time = parseFloat(params[0] ?? '');
  if (!(mode >= 1 && mode <= 6) || !Number.isFinite(time)) return null;
  const size = parseInt(params[2] ?? '', 10);
  const color = parseInt(params[3] ?? '', 10);
  const id = params[7] ?? params[6];
  return {
    time,
    mode,
    size: Number.isFinite(size) && size > 0 ? size : 25,
    color: Number.isFinite(color) ? color & 0xffffff : 0xffffff,
    text: normalise(text),
    pool: parseInt(params[5] ?? '0', 10) || 0,
    ...(id === undefined || id === '' ? {} : { id }),
  };
}

/**
 * B站 XML, tokenised without a DOM (Workers, SSR; and no innerHTML / DOMParser of untrusted
 * markup): every `<d p="...">text</d>`.
 */
export function parseXml(xml: string): ParseResult {
  const comments: ParsedComment[] = [];
  let skipped = 0;
  const re = /<d\s[^>]*?\bp\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/d>/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const raw = m[4] as string;
    const text = decode(raw.startsWith('<![CDATA[') ? raw.slice(9, -3) : raw);
    const c = parseOne(decode(m[2] ?? m[3] ?? ''), text);
    if (c === null) skipped++;
    else comments.push(c);
  }
  return { comments, skipped };
}

/** CCL's common JSON comment (stime in ms), as upstream's CommonDanmakuFormat check. */
export function parseCommon(o: { stime?: unknown; mode?: unknown; size?: unknown; color?: unknown; text?: unknown }): ParsedComment | null {
  if (typeof o.mode !== 'number' || typeof o.stime !== 'number' || typeof o.text !== 'string') return null;
  if (!(o.mode >= 1 && o.mode <= 6)) return null;
  return {
    time: o.stime / 1000,
    mode: o.mode,
    size: typeof o.size === 'number' && o.size > 0 ? o.size : 25,
    color: typeof o.color === 'number' ? o.color & 0xffffff : 0xffffff,
    text: normalise(o.text),
    pool: 0,
  };
}
