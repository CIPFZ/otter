// CMCD (CTA-5004, ADR-005 §2). The session derives the keys from its own state; encoding is
// @svta/cml-cmcd (L1), imported only when CMCD is enabled so it never reaches the first screen.
// Engine adapters call `decorate()` from their request hooks, so all three engines send the same
// key set.

/** CMCD object type of a request (CTA-5004 `ot`). */
export type CmcdObjectKind = 'manifest' | 'audio' | 'video' | 'muxed' | 'init' | 'caption' | 'key' | 'other';

export interface CmcdConfig {
  readonly enabled?: boolean;
  /** `query` (default; works through any CDN) or `headers` (needs CORS allow-headers on the origin). */
  readonly mode?: 'query' | 'headers';
  /** `cid`. */
  readonly contentId?: string;
  /** `sid`; a random UUID per session (load) when omitted. */
  readonly sessionId?: string;
  /** CTA-5004 (1, default; what most CDNs parse today) or CTA-5004-B (2). */
  readonly version?: 1 | 2;
}

export interface CmcdRequestInfo {
  readonly url: string;
  readonly kind: CmcdObjectKind;
  /** Segment duration, seconds. */
  readonly durationS?: number;
  /** Encoded bitrate of the requested object, bits per second. */
  readonly bitrateBps?: number;
}

/** Session state the keys are derived from, read at request time. */
export interface CmcdState {
  readonly format: string | null;
  readonly live: boolean;
  readonly lowLatency: boolean;
  /** Seconds buffered ahead of the playhead. */
  readonly bufferS: number;
  /** bits per second, NaN when unknown. */
  readonly throughputBps: number;
  /** Highest bitrate in the ladder, bits per second, NaN when unknown. */
  readonly topBitrateBps: number;
  readonly playbackRate: number;
  /** Before the first frame. */
  readonly startup: boolean;
  /** A rebuffer happened since the previous request (`bs`, reported once). */
  readonly starved: boolean;
}

export interface CmcdDecoration {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface CmcdDecorator {
  readonly mode: 'query' | 'headers';
  readonly sessionId: string;
  decorate(request: CmcdRequestInfo): CmcdDecoration;
}

/** Plain CMCD key/value object (subset of the library's Cmcd type that Otter fills in). */
export type CmcdKeys = Readonly<Record<string, string | number | boolean>>;

const OBJECT_TYPE: Readonly<Record<CmcdObjectKind, string>> = {
  manifest: 'm',
  audio: 'a',
  video: 'v',
  muxed: 'av',
  init: 'i',
  caption: 'c',
  key: 'k',
  other: 'o',
};

const STREAMING_FORMAT: Readonly<Record<string, string>> = { hls: 'h', dash: 'd' };

const kbps = (bps: number): number | undefined => (Number.isFinite(bps) && bps > 0 ? Math.round(bps / 1000) : undefined);

/** Pure key derivation (CTA-5004 §3): exported for tests and for engines that encode themselves. */
export function cmcdKeys(config: CmcdConfig, sessionId: string, state: CmcdState, request: CmcdRequestInfo): CmcdKeys {
  const media = request.kind === 'audio' || request.kind === 'video' || request.kind === 'muxed';
  const keys: Record<string, string | number | boolean> = { sid: sessionId, ot: OBJECT_TYPE[request.kind] };
  if (config.contentId !== undefined) keys['cid'] = config.contentId;
  const sf = state.format === null ? undefined : STREAMING_FORMAT[state.format];
  if (sf !== undefined) keys['sf'] = sf;
  keys['st'] = state.live ? (state.lowLatency ? 'll' : 'l') : 'v';
  if (state.playbackRate !== 1) keys['pr'] = state.playbackRate;
  if (state.startup) keys['su'] = true;
  if (state.starved) keys['bs'] = true;
  if (media) {
    const br = kbps(request.bitrateBps ?? Number.NaN);
    if (br !== undefined) keys['br'] = br;
    const tb = kbps(state.topBitrateBps);
    if (tb !== undefined) keys['tb'] = tb;
    if (request.durationS !== undefined && request.durationS > 0) keys['d'] = Math.round(request.durationS * 1000);
    keys['bl'] = Math.round(Math.max(0, state.bufferS) * 1000);
    const mtp = kbps(state.throughputBps);
    if (mtp !== undefined) keys['mtp'] = mtp;
  }
  return keys;
}

interface CmcdLib {
  appendCmcdQuery(url: string, cmcd: object, options?: { version?: 1 | 2 }): string;
  toCmcdHeaders(cmcd: object, options?: { version?: 1 | 2 }): Record<string, string>;
}

const uuid = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

/** Loads the encoder (dynamic import) and returns a synchronous decorator for request hooks. */
export async function createCmcdDecorator(config: CmcdConfig, state: () => CmcdState): Promise<CmcdDecorator> {
  const lib = (await import('./cmcd-encoder.js')) as unknown as CmcdLib;
  const mode = config.mode ?? 'query';
  const sessionId = config.sessionId ?? uuid();
  const options = { version: config.version ?? 1 };
  return {
    mode,
    sessionId,
    decorate(request) {
      const keys = cmcdKeys(config, sessionId, state(), request);
      return mode === 'query'
        ? { url: lib.appendCmcdQuery(request.url, keys, options), headers: {} }
        : { url: request.url, headers: lib.toCmcdHeaders(keys, options) };
    },
  };
}
