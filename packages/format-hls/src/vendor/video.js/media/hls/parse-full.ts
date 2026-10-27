// Otter: the parts of SPF's HLS parsers the own engine never needs, moved out of parse-media-playlist.ts and
// parse-multivariant.ts (code unchanged) so the engine chunk does not carry them (ADR-013, M6 batch 1). The own engine
// hands encrypted (EXT-X-KEY) and non-fMP4 (TS / AAC) streams to hls.js before parsing, and has no use for
// EXT-X-SESSION-DATA. Passing these restores upstream's behaviour; the copied SPF tests run with them.
// Derived from video.js@92be7bdd72c8782348ebafc765a23cf8d8cba004 packages/spf/src/media/hls/parse-media-playlist.ts, Apache-2.0

import type { MediaPlaylistKey } from '../types/index.js';
import type { AttributeList } from './parse-attributes.js';
import type { MediaPlaylistExtensions, ParseMediaPlaylistConfig } from './parse-media-playlist.js';
import type { ParseMultivariantConfig } from './parse-multivariant.js';
import type { ResolveKeyUri } from './resolve-url.js';
import { parseSessionData } from './session-data.js';

/**
 * MPEG-2 Transport Stream (IANA `video/MP2T`, lowercased for `isTypeSupported`). Video + audio TS — there is no
 * `audio/mp2t`.
 */
export const MPEG_TS_MIME = 'video/mp2t';
/** Raw ADTS AAC packed-audio (HLS `.aac` segments; IANA `audio/aac`). */
export const RAW_AAC_MIME = 'audio/aac';

// Non-fMP4 container MIMEs keyed by segment file extension. fMP4 (the MSE
// default) always carries an EXT-X-MAP init segment, so a media playlist with
// no init segment and one of these extensions is a non-fMP4 rendition,
// relabeled from the fMP4 default. Extend with `.mp3` → 'audio/mpeg' etc.
const CONTAINER_MIME_BY_EXTENSION: Record<string, string> = {
  '.ts': MPEG_TS_MIME,
  '.aac': RAW_AAC_MIME,
};

/** The non-fMP4 container MIMEs the parser detects — all currently treated as unplayable. */
export const NON_FMP4_CONTAINER_MIMES: Set<string> = new Set(Object.values(CONTAINER_MIME_BY_EXTENSION));

/**
 * Non-fMP4 container MIME for a (resolved, absolute) segment URL, by file extension, ignoring the query string.
 * `undefined` for fMP4 / unrecognized.
 */
function containerMimeFromSegment(url: string | undefined): string | undefined {
  if (!url) return undefined;

  let path: string;

  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase().split('?')[0] ?? '';
  }

  const dot = path.lastIndexOf('.');

  return dot === -1 ? undefined : CONTAINER_MIME_BY_EXTENSION[path.slice(dot)];
}

/** An `EXT-X-KEY` with a real METHOD (upstream's block, the dedupe left to the parser). */
function parseKey(key: AttributeList, baseUrl: string, resolveKey: ResolveKeyUri): { readonly identity: string; readonly key: MediaPlaylistKey } | undefined {
  const method = key.get('METHOD');

  if (method === undefined || method === 'NONE') return undefined;

  const uri = key.get('URI');
  const keyFormat = key.get('KEYFORMAT');
  const keyId = key.get('KEYID');
  const iv = key.get('IV');
  const identity = [method, uri, keyFormat, keyId, iv].join(' ');

  return {
    identity,
    key: {
      method,
      ...(uri !== undefined && { uri: resolveKey(uri, baseUrl) }),
      ...(keyFormat !== undefined && { keyFormat }),
      ...(keyId !== undefined && { keyId }),
      ...(iv !== undefined && { iv }),
    },
  };
}

const MEDIA_EXTENSIONS: MediaPlaylistExtensions = { key: parseKey, container: containerMimeFromSegment };

/** parseMediaPlaylist's config for upstream's full behaviour (keys, non-fMP4 relabeling). */
export const FULL_MEDIA_PLAYLIST: ParseMediaPlaylistConfig = { extensions: MEDIA_EXTENSIONS };

/** parseMultivariantPlaylist's config for upstream's full behaviour (session data). */
export const FULL_MULTIVARIANT: ParseMultivariantConfig = { sessionData: parseSessionData };
