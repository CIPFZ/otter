// Own CMAF-HLS engine (ADR-010): fMP4 HLS over MSE without hls.js. SPF's parsers, buffer planning
// and reload policy (L3, vendor/video.js), Otter's MSE sink with its segment ledger, ABR driver and
// LiveController (live.ts, its own chunk). One lane per SourceBuffer (video, possibly with muxed
// audio; a separate audio rendition), each a loop: pick the next segment SPF's forward-buffer plan
// asks for, fetch, append, record. Quality switches never flush: the new rendition takes over after
// what is buffered (like format-mp4-range). PTS are not shifted: media time = playlist time +
// `offset`, read from the first segment's tfdt. What it does not do (discontinuities, encryption, TS
// segments, LL-HLS parts, I-frame playlists, variants without CODECS) is reported at load as
// `ownEngineUnsupported`, and withAdapterFallback hands the stream to hls.js.

import type { createError as CreateError, createEventBus as CreateEventBus, isOtterError as IsOtterError, OtterError } from '@otter-player/core';
import type { AudioTrack, CmcdObjectKind, Engine, EngineContext, EngineEvents, TextTrackInfo, TrackList, VideoTrack } from '@otter-player/media';
// The sink sub-path: no @otter-player/core in the engine's module graph (CoreHelpers).
import { createMseSink, type MseSink } from '@otter-player/engine-pipeline/sink';
import { createAbrDriverWith, createLeanAbrController, type AbrDriver, type AbrLevel } from '@otter-player/pipeline';
import { getSegmentsToLoad } from '../vendor/video.js/media/buffer/forward-buffer.js';
import { parseMediaPlaylist } from '../vendor/video.js/media/hls/parse-media-playlist.js';
import { parseMultivariantPlaylist } from '../vendor/video.js/media/hls/parse-multivariant.js';
import { findMediaTrack, readBaseMediaDecodeTime } from '../vendor/video.js/media/mp4/timestamp-origin.js';
import {
  getMediaPlaylistMetadata,
  type AddressableObject,
  type PartiallyResolvedAudioTrack,
  type PartiallyResolvedTextTrack,
  type PartiallyResolvedVideoTrack,
  type Presentation,
  type ResolvedTrack,
  type Segment,
} from '../vendor/video.js/media/types/index.js';
import { buildMimeCodec } from '../vendor/video.js/media/utils/tracks.js';
import type { Live } from './live.js';

export interface CmafHlsEngineOptions {
  /** Seconds buffered ahead before loading pauses (hls.js maxBufferLength). Default 30. */
  readonly forwardBufferS?: number;
  /** Live: latency to hold, seconds; default the playlist's HOLD-BACK (3 x TARGETDURATION). */
  readonly targetLatency?: number;
}

type Partial = PartiallyResolvedVideoTrack | PartiallyResolvedAudioTrack | PartiallyResolvedTextTrack;
type Kind = 'video' | 'audio';

// `_` fields: objects internal to this package (lanes, the view the on-demand chunks get, core's
// helpers handed in); the build gives them short names (esbuild mangleProps /^_/, mangle-cache.json;
// AGENT.md §4, ADR-013). Public API and objects passed to other packages keep their names.

interface Lane {
  readonly _type: Kind;
  /** Variant (video) or rendition (audio) index. */
  _index: number;
  _track: ResolvedTrack;
  /** Init segment bytes of `track` and what they were fetched for. */
  _init: Uint8Array | undefined;
  _initKey: string | undefined;
  /** Init must go in before the next media segment (start, a seek's abort, a switch). */
  _needsInit: boolean;
  _ended: boolean;
  _timing: { readonly trackId: number; readonly timescale: number } | undefined;
}

const DEFAULT_FORWARD_S = 30;
const BACK_BUFFER_S = 30;
const RETRIES = 3;

/**
 * @otter-player/core's helpers, handed in by the lazy wrapper: a value import shared with the
 * entry chunk would make core lazily initialised in single-file bundles (side-effects gate).
 */
export interface CoreHelpers {
  readonly _createError: typeof CreateError;
  readonly _createEventBus: typeof CreateEventBus;
  readonly _isOtterError: typeof IsOtterError;
}
const aborted = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * What the engine leaves to hls.js (ADR-010 §2), named by the tag found in a playlist's text;
 * `subtitles`: a WebVTT rendition's playlist (no init segment there).
 */
export function unsupportedIn(text: string, master: boolean, subtitles = false): string | undefined {
  const tag = (t: string): boolean => new RegExp(`^#${t}(:|$)`, 'm').test(text);
  if (master) {
    // CEA-608 / 708 in the video samples: hls.js extracts them, this engine does not (yet).
    return ['EXT-X-I-FRAME-STREAM-INF', 'EXT-X-SESSION-KEY'].find(tag) ?? (/TYPE=CLOSED-CAPTIONS,(?!.*INSTREAM-ID="?NONE)/.test(text) ? 'CLOSED-CAPTIONS' : undefined);
  }
  if (/^#EXT-X-KEY:(?!METHOD=NONE)/m.test(text)) return 'EXT-X-KEY';
  return (
    ['EXT-X-DISCONTINUITY', 'EXT-X-PART', 'EXT-X-PART-INF', 'EXT-X-GAP'].find(tag) ??
    (/PART-HOLD-BACK/.test(text) ? 'EXT-X-PART' : subtitles || tag('EXT-X-MAP') ? undefined : /^[^#\s].*\.(ts|aac|mp3|ac3)(\?|$)/im.test(text) ? 'TS segments' : 'no EXT-X-MAP')
  );
}

/**
 * What the on-demand chunks (subtitles.ts, abandon.ts, live.ts) use of the engine: one object, so
 * the engine chunk does not build a hook set per chunk (ADR-010 §3 budget).
 */
export interface EngineInner {
  readonly _media: HTMLMediaElement;
  readonly _forwardS: number;
  readonly _core: CoreHelpers;
  readonly _bus: { emit<E extends keyof EngineEvents>(e: E, p: EngineEvents[E]): void };
  _isLive(): boolean;
  /** Media playlist of a rendition (live: aligned to the playing video). */
  _resolve(partial: PartiallyResolvedVideoTrack | PartiallyResolvedAudioTrack | PartiallyResolvedTextTrack): Promise<ResolvedTrack>;
  /** Drops a cached playlist (live subtitles are re-read). */
  _forget(id: string): void;
  _get(o: AddressableObject, kind: CmcdObjectKind): Promise<{ data: ArrayBuffer }>;
  _playlistTime(): number;
  _offset(): number;
  /** Seconds of video buffered ahead. */
  _aheadS(): number;
  /** Video variants in manifest order, and whether their playlists are loaded. */
  readonly _variants: readonly PartiallyResolvedVideoTrack[];
  _loaded(id: string): boolean;
  readonly _driver: AbrDriver | undefined;
  /** The text track selected now (cues of another one are dropped). */
  _textTrack(): string | null;
  // Live (live.ts):
  readonly _mediaSource: MediaSource;
  /** Host override of the target latency, seconds. */
  readonly _targetLatency: number | undefined;
  /** The playing video rendition (its HOLD-BACK is the target). */
  _track(): ResolvedTrack;
  /** The DVR window on the media timeline, undefined before the first segment's timing is known. */
  _window(): { readonly start: number; readonly end: number } | undefined;
  /** performance.now() when the playing playlist's response arrived (the first load). */
  readonly _loadedAt: number;
  /** Reloads the playing media playlists: [before, after] per rendition. */
  _refresh(): Promise<readonly (readonly [ResolvedTrack, ResolvedTrack])[]>;
  /** ENDLIST arrived: no more reloads. */
  _ended(): void;
}

function mediaSourceCtor(preferManaged: boolean): { Ctor: typeof MediaSource; managed: boolean } | undefined {
  const g = globalThis as { ManagedMediaSource?: typeof MediaSource; MediaSource?: typeof MediaSource };
  if (g.ManagedMediaSource !== undefined && (preferManaged || g.MediaSource === undefined)) return { Ctor: g.ManagedMediaSource, managed: true };
  return g.MediaSource === undefined ? undefined : { Ctor: g.MediaSource, managed: false };
}

const segEnd = (s: Segment): number => s.startTime + s.duration;
/** `{ [key]: value }` when the value is there (exactOptionalPropertyTypes). */
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]: V }));
const lastEnd = (t: ResolvedTrack): number => {
  const last = t.segments.at(-1);
  return last === undefined ? 0 : segEnd(last);
};

export function createCmafHlsEngine(ctx: EngineContext, options: CmafHlsEngineOptions, core: CoreHelpers): Engine & { seekToLive(): void } {
  const { _createError: createError, _createEventBus: createEventBus, _isOtterError: isOtterError } = core;
  const fatal = (type: OtterError['type'], details: string, message: string, cause?: unknown): OtterError =>
    createError({ type, details, fatal: true, recoverable: type === 'network', message, ...opt('cause', cause) });
  const unsupported = (why: string): OtterError => fatal('media', 'ownEngineUnsupported', why);
  const forwardS = options.forwardBufferS ?? DEFAULT_FORWARD_S;
  const bus = createEventBus<EngineEvents>();
  const media = ctx.media;
  const abort = new AbortController();
  let sink: MseSink | undefined;
  let driver: AbrDriver | undefined;
  let live: Live | undefined;
  let tracks: TrackList = { video: [], audio: [], text: [], quality: 'opaque', requestedQuality: 'auto' };
  let managed = false;
  let destroyed = false;
  let isLive = false;
  /** Media time minus playlist time, from the first segment's tfdt. */
  let offset: number | undefined;
  /** Playlist time to start at while `offset` is unknown. */
  let startAt = 0;
  let epoch = 0;
  let requested: number | undefined;
  let variants: PartiallyResolvedVideoTrack[] = [];
  let audios: PartiallyResolvedAudioTrack[] = [];
  let texts: PartiallyResolvedTextTrack[] = [];
  const resolved = new Map<string, ResolvedTrack>();
  const lanes: Lane[] = [];
  let selectedText: string | null = null;
  let stopText: (() => void) | undefined;
  let switchReason = 'start';
  /** Variant an abandoned download asked for (the next segment comes from it). */
  let forced: number | undefined;
  let abandon: import('./abandon.js').Abandon | undefined;
  let endSignalled = false;
  /** performance.now() when the first media playlist arrived (live edge without PROGRAM-DATE-TIME). */
  let loadedAt = 0;


  // --- network ---------------------------------------------------------------------------------

  /** GET with Range, CMCD and retries (network errors and 5xx); download stats for ABR. */
  /** `variant`: a video segment of that variant in auto mode, watched by the abandon chunk. */
  const get = async (o: AddressableObject, kind: CmcdObjectKind, extra: { durationS?: number; bitrateBps?: number } = {}, variant?: number): Promise<{ data: ArrayBuffer; ms: number; ttfbMs: number }> => {
    const cmcd = ctx.cmcd?.decorate({ url: o.url, kind, ...extra });
    const headers: Record<string, string> = { ...ctx.source.headers, ...cmcd?.headers };
    if (o.byteRange !== undefined) headers['Range'] = `bytes=${o.byteRange.start}-${o.byteRange.end}`;
    let last: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt > 0) await wait(500 * 2 ** (attempt - 1));
      abort.signal.throwIfAborted();
      const began = performance.now();
      try {
        const res = await fetch(cmcd?.url ?? o.url, { headers, signal: abort.signal });
        const ttfbMs = performance.now() - began;
        if (!res.ok) {
          last = new Error(`HTTP ${res.status}`);
          if (res.status < 500) break;
          continue;
        }
        const data = await (abandon !== undefined && variant !== undefined ? abandon._read(res, variant, extra.durationS ?? 0, began, ttfbMs) : res.arrayBuffer());
        return { data, ms: performance.now() - began, ttfbMs };
      } catch (err) {
        if (aborted(err) || (err as { variant?: number }).variant !== undefined) throw err;
        last = err;
      }
    }
    throw fatal('network', kind === 'manifest' ? 'manifestLoadError' : 'fragLoadError', `${o.url}: ${String(last)}`, last);
  };
  const getText = async (url: string): Promise<string> => new TextDecoder().decode((await get({ url }, 'manifest')).data);

  /** Media playlist of `partial`, parsed (live: onto `ref`'s timeline), checked for what we leave to hls.js. */
  const resolve = async (partial: Partial, ref?: ResolvedTrack): Promise<ResolvedTrack> => {
    const prev = resolved.get(partial.id);
    // VOD playlists do not change: once is enough.
    if (prev !== undefined && Number.isFinite(prev.duration)) return prev;
    const text = await getText(partial.url);
    const why = unsupportedIn(text, false, partial.type === 'text');
    if (why !== undefined) throw unsupported(why);
    // A reload of the same rendition carries SPF's own timeline forward; another rendition is
    // aligned to the playing one by media sequence.
    const parsed = parseMediaPlaylist(text, (prev ?? partial) as Partial) as ResolvedTrack;
    // Live only, from the live chunk (the first renditions are the reference: nothing to align yet).
    const track = prev === undefined && isLive && live !== undefined ? live._align(parsed, ref) : parsed;
    resolved.set(partial.id, track);
    return track;
  };

  // --- tracks ----------------------------------------------------------------------------------

  const levels = (): AbrLevel[] => variants.map((v, i) => ({ id: `video-${i}`, bitrate: v.bandwidth, ...opt('width', v.width), ...opt('height', v.height) }));

  const describe = (): void => {
    const vIndex = videoLane()?._index;
    const aIndex = lanes.find((l) => l._type === 'audio')?._index ?? 0;
    const video: VideoTrack[] = variants.map((v, i) => ({
      kind: 'video',
      id: `video-${i}`,
      selected: vIndex === i,
      bitrate: v.bandwidth,
      ...opt('width', v.width),
      ...opt('height', v.height),
      ...opt('codec', v.codecs[0]),
    }));
    const audio: AudioTrack[] = audios.map((a, i) => ({ kind: 'audio', id: `audio-${i}`, selected: aIndex === i, label: a.name, ...opt('language', a.language), ...opt('codec', a.codecs[0]) }));
    const text: TextTrackInfo[] = texts.map((t, i) => ({
      kind: 'text',
      id: `text-${i}`,
      role: t.forced === true ? 'forced' : 'subtitles',
      label: t.label,
      selected: selectedText === `text-${i}`,
      ...opt('language', t.language),
    }));
    tracks = { video, audio, text, quality: variants.length > 1 ? 'selectable' : 'opaque', requestedQuality: requested === undefined ? 'auto' : `video-${requested}` };
    bus.emit('tracks-change', tracks);
  };

  // --- timeline --------------------------------------------------------------------------------

  const playlistTime = (): number => (offset === undefined ? startAt : media.currentTime - offset);
  const videoLane = (): Lane | undefined => lanes.find((l) => l._type === 'video');
  /** DVR window on the media timeline. */
  const window = (): { start: number; end: number } | undefined => {
    const lane = videoLane();
    if (lane === undefined || offset === undefined || lane._track.segments.length === 0) return undefined;
    return { start: (lane._track.segments[0] as Segment).startTime + offset, end: lastEnd(lane._track) + offset };
  };
  const aheadOf = (type: Kind): number => {
    const t = media.currentTime;
    return (sink?.buffered(type).find(([a, b]) => a <= t + 0.1 && t < b)?.[1] ?? t) - t;
  };

  /** From the first media segment: media - playlist time, and the start position on the element. */
  const establish = (lane: Lane, seg: Segment, data: ArrayBuffer): void => {
    if (offset !== undefined || lane._timing === undefined) return;
    const bmdt = readBaseMediaDecodeTime(data, lane._timing.trackId);
    offset = bmdt === undefined ? 0 : bmdt / lane._timing.timescale - seg.startTime;
    const s = sink as MseSink;
    if (!isLive && Number.isFinite(lane._track.duration)) {
      try {
        s.mediaSource.duration = offset + lane._track.duration;
      } catch {
        // Set again by the appends.
      }
    }
  };

  // --- lanes -----------------------------------------------------------------------------------

  /**
   * Init segments of `batch` into the sink together. Until the first media append that is every
   * lane: a separate audio rendition's SourceBuffer must exist before any video data (Chromium
   * refuses addSourceBuffer after that).
   */
  const appendInit = async (batch: Lane[], run: number): Promise<boolean> => {
    for (const lane of batch) {
      lane._needsInit = false;
      const init = lane._track.initialization;
      if (init === undefined || init.url === '') throw unsupported('no EXT-X-MAP');
      const key = `${init.url}#${init.byteRange?.start ?? ''}`;
      if (lane._initKey !== key || lane._init === undefined) {
        const { data } = await get(init, 'init');
        if (run !== epoch) return false;
        lane._init = new Uint8Array(data);
        lane._initKey = key;
        lane._timing = findMediaTrack(data, lane._type === 'video' && lane._track.type === 'video' ? 'vide' : 'soun');
      }
    }
    await (sink as MseSink).init(batch.map((lane) => ({ type: lane._type, mimeType: buildMimeCodec(lane._track), data: lane._init as Uint8Array })));
    return true;
  };

  /** ABR or the manual choice, before the next video segment is picked. */
  const chooseVariant = async (lane: Lane, run: number): Promise<void> => {
    let target = requested ?? forced ?? lane._index;
    forced = undefined;
    // A driver exists only with more than one variant.
    if (target === lane._index && requested === undefined && driver?.canEstimate === true) {
      const meta = getMediaPlaylistMetadata(lane._track);
      const d = driver.decide({ levels: levels(), current: lane._index, bufferLevel: aheadOf('video'), segmentDuration: meta?.targetDuration ?? 6, live: isLive, lowLatency: false, bufferTarget: forwardS });
      if (d.engineLevel >= 0) target = d.engineLevel;
      if (target !== lane._index) switchReason = `abr: ${d.reason}`;
    }
    if (target === lane._index) return;
    const track = await resolve(variants[target] as PartiallyResolvedVideoTrack, lane._track);
    if (run !== epoch) return;
    lane._index = target;
    lane._track = track;
    lane._needsInit = true;
    lane._ended = false;
    driver?.applied(target, levels());
    describe();
    bus.emit('quality-change', { id: `video-${target}`, auto: requested === undefined, reason: requested === undefined ? switchReason : 'manual' });
  };

  /** One segment for `lane`; false when there is nothing to do right now. */
  const step = async (lane: Lane, run: number): Promise<boolean> => {
    const s = sink as MseSink;
    // A separate audio rendition keeps at most one segment ahead of the buffered video, like
    // hls.js: running its own 30 s ahead it took the link from the video (1 Mbps: rebuffering).
    const ahead = lane._type === 'audio' && videoLane() ? Math.min(forwardS, aheadOf('video') + (lane._track.segments[0]?.duration ?? 6)) : forwardS;
    if (aheadOf(lane._type) >= ahead) return false;
    const plan = () => {
      const inLedger = new Set(s.segments(lane._type).map((x) => x.id));
      const buffered = lane._track.segments.filter((x) => inLedger.has(x.id));
      return { inLedger, next: getSegmentsToLoad(lane._track.segments, buffered, playlistTime(), { bufferDuration: ahead })[0] };
    };
    let { inLedger, next } = plan();
    // ABR only when there is a segment to load: at the end of a VOD the buffer drains and
    // InsufficientBuffer would call it empty. A manual choice applies at once, like hls.js'.
    if ((next !== undefined || requested !== undefined) && lane._type === 'video') {
      const before = lane._track;
      await chooseVariant(lane, run);
      if (run !== epoch) return true;
      if (lane._track !== before) ({ inLedger, next } = plan());
    }
    if (next === undefined) {
      const last = lane._track.segments.at(-1);
      if (!isLive && last !== undefined && inLedger.has(last.id)) {
        lane._ended = true;
        if (!endSignalled && lanes.every((l) => l._ended)) {
          endSignalled = true;
          s.endOfStream();
        }
      }
      return false;
    }
    if (lane._needsInit && !(await appendInit(offset === undefined ? lanes : [lane], run))) return true;
    const kind: CmcdObjectKind = lane._type === 'audio' ? 'audio' : lane._track.codecs !== undefined && lane._track.codecs.length > 1 ? 'muxed' : 'video';
    const { data, ms, ttfbMs } = await get(next, kind, { durationS: next.duration, bitrateBps: lane._track.bandwidth }, lane._type === 'video' && requested === undefined ? lane._index : undefined);
    if (run !== epoch) return true;
    // Bandwidth from video segments only, like hls.js (main fragments): a separate audio
    // rendition's small segments, moving in step with the video, read high and kept a variant
    // the link could not hold (abandon, then back up: two switches at 3 Mbps).
    if (lane._type === 'video') driver?.sampleDownload(ms, data.byteLength, ttfbMs);
    if (driver?.canEstimate === true) {
      const b = driver.bandwidth;
      bus.emit('bandwidth', { estimate: b.estimate, fast: b.fast, slow: b.slow });
    }
    const first = offset === undefined;
    establish(lane, next, data);
    const o = offset ?? 0;
    await s.append(lane._type, new Uint8Array(data), { id: next.id, start: next.startTime + o, end: segEnd(next) + o, level: lane._index });
    // The start position, once the first segment is in (so the seek finds it buffered).
    if (first && offset !== undefined && Math.abs(media.currentTime - (startAt + offset)) > 0.01) media.currentTime = startAt + offset;
    if (lane._type === 'video') driver?.segmentAppended();
    await s.evict(media.currentTime);
    return true;
  };

  const fail = (err: unknown): void => {
    if (destroyed || aborted(err)) return;
    bus.emit('error', isOtterError(err) ? err : fatal('media', 'bufferAppendError', String(err), err));
  };

  const run = async (lane: Lane): Promise<void> => {
    while (!destroyed) {
      const s = sink as MseSink;
      // ManagedMediaSource not streaming (buffer full, or ended): wait, but look again every 200 ms
      // so a manual choice made meanwhile applies.
      if (!s.streaming && lane._index === (requested ?? lane._index)) {
        await Promise.race([s.whenStreaming(), wait(200)]);
        continue;
      }
      const e = epoch;
      let busy: boolean;
      try {
        busy = await step(lane, e);
      } catch (err) {
        if (aborted(err) && e !== epoch) continue;
        // An abandoned download (abandon.ts, a non-fatal error): its reason to the route and QoE,
        // the next try at the variant it names.
        forced = (err as { variant?: number }).variant;
        if (forced !== undefined) {
          switchReason = (err as Error).message;
          bus.emit('error', err as OtterError);
          continue;
        }
        fail(err);
        return;
      }
      if (!busy) await wait(200);
    }
  };

  const onSeeking = (): void => {
    const t = media.currentTime;
    for (let i = 0; i < media.buffered.length; i++) if (media.buffered.start(i) <= t && t < media.buffered.end(i)) return;
    epoch++;
    sink?.abort();
    for (const l of lanes) {
      l._needsInit = true;
      l._ended = false;
    }
    endSignalled = false;
    driver?.reset();
  };

  const inner: EngineInner = {
    _media: media,
    _forwardS: forwardS,
    _core: core,
    _bus: bus,
    _isLive: () => isLive,
    _resolve: (p) => resolve(p, videoLane()?._track),
    _forget: (id) => resolved.delete(id),
    _get: get,
    _playlistTime: playlistTime,
    _offset: () => offset ?? 0,
    _aheadS: () => aheadOf('video'),
    get _variants() {
      return variants;
    },
    _loaded: (id) => resolved.has(id),
    get _driver() {
      return driver;
    },
    _textTrack: () => selectedText,
    get _mediaSource() {
      return (sink as MseSink).mediaSource;
    },
    _targetLatency: options.targetLatency,
    _track: () => (videoLane() as Lane)._track,
    _window: window,
    get _loadedAt() {
      return loadedAt;
    },
    // Reloads the playing renditions (a switch in flight keeps its new track).
    _refresh: () =>
      Promise.all(
        lanes.map(async (lane) => {
          const before = lane._track;
          const next = await resolve((lane._type === 'video' ? variants : audios)[lane._index] as Partial, before);
          if (lane._track === before) lane._track = next;
          return [before, next] as const;
        }),
      ),
    // ENDLIST: the event became VOD; endOfStream sets the duration where the media ends.
    _ended: () => (isLive = false),
  };

  return {
    formatId: 'hls',
    get tracks() {
      return tracks;
    },
    get latency() {
      return isLive ? live?._latency : undefined;
    },
    get targetLatency() {
      return isLive ? live?._targetLatency : undefined;
    },
    get mms() {
      return managed;
    },
    async load() {
      const url = ctx.source.src;
      if (typeof url !== 'string') throw fatal('other', 'unsupportedSource', 'HLS plays playlist URLs');
      const masterUrl = new URL(url, globalThis.location?.href).href;
      const text = await getText(masterUrl);
      if (destroyed) return;
      if (!text.includes('#EXT-X-STREAM-INF')) throw unsupported('no multivariant playlist');
      const whyMaster = unsupportedIn(text, true);
      if (whyMaster !== undefined) throw unsupported(whyMaster);
      const presentation: Presentation = parseMultivariantPlaylist(text, { url: masterUrl });
      const of = <T extends Partial>(type: string): T[] =>
        presentation.selectionSets.filter((s) => s.type === type).flatMap((s) => s.switchingSets.flatMap((ss) => ss.tracks as T[]));
      const allVariants = of<PartiallyResolvedVideoTrack>('video');
      if (allVariants.some((v) => v.codecs.length === 0)) throw unsupported('no CODECS');
      const MS = mediaSourceCtor(ctx.mms);
      if (MS === undefined) throw fatal('media', 'engineUnsupported', 'no MediaSource here');
      const playable = (t: { mimeType: string; codecs?: string[] }): boolean => MS.Ctor.isTypeSupported(buildMimeCodec(t));
      // One video codec family: the best-ranked one offered (ADR-011 batch 3).
      variants = ctx.codecs.pick(allVariants.filter(playable));
      if (variants.length === 0) throw unsupported('no variant MSE plays');
      audios = of<PartiallyResolvedAudioTrack>('audio').filter((a) => a.url !== '' && (a.codecs.length === 0 || playable(a)));
      texts = of<PartiallyResolvedTextTrack>('text');
      // The MediaSource opens while the media playlists load.
      managed = MS.managed;
      const s = createMseSink(MS.Ctor, { backBufferS: BACK_BUFFER_S });
      sink = s;
      // ManagedMediaSource opens only with remote playback off or an AirPlay <source>; for HLS the
      // alternate is the playlist itself, added by backend-mse after load (as for hls.js).
      if (managed && media.querySelector('source') === null) media.disableRemotePlayback = true;
      media.src = s.url;
      // Start like hls.js: the first variant listed (ABR decides once it has samples).
      const first = variants[0] as PartiallyResolvedVideoTrack;
      const groups = first.audioGroupIds ?? [];
      const audioIndex = audios.findIndex((a) => groups.includes(a.groupId) && a.default === true);
      const startAudio = audioIndex >= 0 ? audioIndex : audios.findIndex((a) => groups.includes(a.groupId));
      const [vTrack, aTrack] = await Promise.all([resolve(first), startAudio >= 0 ? resolve(audios[startAudio] as PartiallyResolvedAudioTrack) : undefined]);
      loadedAt = performance.now();
      if (destroyed) return;
      isLive = !Number.isFinite(vTrack.duration);
      // Lean rule stack (Throughput + InsufficientBuffer): the engine chunk budget (ADR-010 §3).
      // The abandon rules (an on-demand chunk) watch video downloads in auto mode. The buffer cap
      // from the second segment on (dash.js waits for two): after a first segment at the link's
      // edge it steps down at once instead of starting a second one it then abandons.
      if (variants.length > 1) {
        driver = createAbrDriverWith(createLeanAbrController({ insufficientBuffer: { segmentIgnoreCount: 1 } }));
        void import('./abandon.js').then((m) => (abandon = m.createAbandon(inner)));
      }
      await s.ready;
      if (destroyed) return;
      const lane = (type: Kind, index: number, track: ResolvedTrack): Lane => ({ _type: type, _index: index, _track: track, _init: undefined, _initKey: undefined, _needsInit: true, _ended: false, _timing: undefined });
      lanes.push(lane('video', 0, vTrack));
      if (aTrack !== undefined) lanes.push(lane('audio', startAudio, aTrack));
      describe();
      bus.emit('quality-change', { id: 'video-0', auto: true, reason: 'start' });
      if (isLive) {
        try {
          s.mediaSource.duration = Number.POSITIVE_INFINITY;
        } catch {
          // Some engines reject Infinity before the first SourceBuffer.
        }
        const { startLive } = await import('./live.js');
        if (destroyed) return;
        live = startLive(inner);
        startAt = live._startAt;
      } else {
        startAt = ctx.options.startTime ?? 0;
      }
      media.addEventListener('seeking', onSeeking);
      // Resolve once the first video segment is in (the other engines resolve on media info).
      const v = lanes[0] as Lane;
      const e = epoch;
      while (!destroyed && (sink.segments('video').length === 0)) {
        if (!(await step(v, e))) break;
      }
      if (destroyed) return;
      bus.emit('first-segment', { at: performance.now() });
      for (const l of lanes) void run(l);
    },
    selectQuality(id) {
      const index = Number(id.replace(/^video-/, ''));
      requested = id !== 'auto' && index >= 0 && index < variants.length ? index : undefined;
      describe();
      // A manual choice shows soon, like hls.js: the video buffered from the first segment
      // boundary at least a second ahead goes, and the lane refills from there.
      const lane = videoLane();
      if (requested === undefined || lane === undefined || sink === undefined || requested === lane._index) return;
      const from = sink.segments('video').find((x) => x.start >= media.currentTime + 1)?.start;
      if (from === undefined) return;
      epoch++;
      sink.abort('video');
      lane._needsInit = true;
      lane._ended = false;
      endSignalled = false;
      void sink.remove('video', from, Number.POSITIVE_INFINITY).catch(fail);
    },
    selectAudioTrack(id) {
      const index = Number(id.replace(/^audio-/, ''));
      const lane = lanes.find((l) => l._type === 'audio');
      if (lane === undefined || !Number.isInteger(index) || index === lane._index || audios[index] === undefined) return;
      const run0 = ++epoch;
      sink?.abort('audio');
      void (async () => {
        const track = await resolve(audios[index] as PartiallyResolvedAudioTrack, videoLane()?._track);
        if (run0 !== epoch) return;
        lane._index = index;
        lane._track = track;
        lane._needsInit = true;
        lane._ended = false;
        endSignalled = false;
        // The old language ahead of the playhead goes; the lane refills from here.
        await sink?.clear('audio');
        describe();
      })().catch(fail);
    },
    selectTextTrack(id) {
      stopText?.();
      stopText = undefined;
      selectedText = id;
      const partial = id === null ? undefined : texts[Number(id.replace(/^text-/, ''))];
      describe();
      if (partial !== undefined)
        void import('./subtitles.js').then((m) => {
          if (!destroyed && selectedText === id) stopText = m.loadSubtitles(inner, partial, id as string);
        });
    },
    seekToLive: () => live?._seekToLive(),
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      destroyed = true;
      epoch++;
      abort.abort();
      stopText?.();
      live?._destroy();
      media.removeEventListener('seeking', onSeeking);
      sink?.destroy();
      sink = undefined;
      bus.clear();
    },
  };
}
