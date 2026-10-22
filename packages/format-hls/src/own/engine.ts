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

interface Lane {
  readonly type: Kind;
  /** Variant (video) or rendition (audio) index. */
  index: number;
  track: ResolvedTrack;
  /** Init segment bytes of `track` and what they were fetched for. */
  init: Uint8Array | undefined;
  initKey: string | undefined;
  /** Init must go in before the next media segment (start, a seek's abort, a switch). */
  needsInit: boolean;
  ended: boolean;
  timing: { readonly trackId: number; readonly timescale: number } | undefined;
}

const DEFAULT_FORWARD_S = 30;
const BACK_BUFFER_S = 30;
const RETRIES = 3;

/**
 * @otter-player/core's helpers, handed in by the lazy wrapper: a value import shared with the
 * entry chunk would make core lazily initialised in single-file bundles (side-effects gate).
 */
export interface CoreHelpers {
  readonly createError: typeof CreateError;
  readonly createEventBus: typeof CreateEventBus;
  readonly isOtterError: typeof IsOtterError;
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

function mediaSourceCtor(preferManaged: boolean): { Ctor: typeof MediaSource; managed: boolean } | undefined {
  const g = globalThis as { ManagedMediaSource?: typeof MediaSource; MediaSource?: typeof MediaSource };
  if (g.ManagedMediaSource !== undefined && (preferManaged || g.MediaSource === undefined)) return { Ctor: g.ManagedMediaSource, managed: true };
  return g.MediaSource === undefined ? undefined : { Ctor: g.MediaSource, managed: false };
}

const segEnd = (s: Segment): number => s.startTime + s.duration;
/** `{ [key]: value }` when the value is there (exactOptionalPropertyTypes). */
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]: V }));
const lastEnd = (t: ResolvedTrack): number => (t.segments.length === 0 ? 0 : segEnd(t.segments[t.segments.length - 1] as Segment));

/** `fresh`'s segments moved onto `ref`'s timeline by a segment both have (same media sequence id). */
function align(fresh: ResolvedTrack, ref: ResolvedTrack | undefined): ResolvedTrack {
  if (ref === undefined) return fresh;
  const byId = new Map(ref.segments.map((s) => [s.id, s.startTime]));
  const common = fresh.segments.find((s) => byId.has(s.id));
  const shift = common === undefined ? (ref.segments[0]?.startTime ?? 0) - (fresh.segments[0]?.startTime ?? 0) : (byId.get(common.id) as number) - common.startTime;
  return shift === 0 ? fresh : { ...fresh, segments: fresh.segments.map((s) => ({ ...s, startTime: s.startTime + shift })) };
}

export function createCmafHlsEngine(ctx: EngineContext, options: CmafHlsEngineOptions, core: CoreHelpers): Engine & { seekToLive(): void } {
  const { createError, createEventBus, isOtterError } = core;
  const fatal = (type: OtterError['type'], details: string, message: string, cause?: unknown): OtterError =>
    createError({ type, details, fatal: true, recoverable: type === 'network', message, ...(cause === undefined ? {} : { cause }) });
  const unsupported = (why: string): OtterError => createError({ type: 'media', details: 'ownEngineUnsupported', fatal: true, recoverable: false, message: why });
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
  let endSignalled = false;

  // --- network ---------------------------------------------------------------------------------

  /** GET with Range, CMCD and retries (network errors and 5xx); download stats for ABR. */
  const get = async (o: AddressableObject, kind: CmcdObjectKind, extra: { durationS?: number; bitrateBps?: number } = {}): Promise<{ data: ArrayBuffer; ms: number; ttfbMs: number }> => {
    const cmcd = ctx.cmcd?.decorate({ url: o.url, kind, ...extra });
    const headers: Record<string, string> = { ...ctx.source.headers, ...cmcd?.headers };
    if (o.byteRange !== undefined) headers['Range'] = `bytes=${o.byteRange.start}-${o.byteRange.end}`;
    let last: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt > 0) await wait(500 * 2 ** (attempt - 1));
      if (destroyed) throw Object.assign(new Error('destroyed'), { name: 'AbortError' });
      const began = performance.now();
      try {
        const res = await fetch(cmcd?.url ?? o.url, { headers, signal: abort.signal });
        const ttfbMs = performance.now() - began;
        if (!res.ok) {
          last = new Error(`HTTP ${res.status}`);
          if (res.status < 500) break;
          continue;
        }
        const data = await res.arrayBuffer();
        return { data, ms: performance.now() - began, ttfbMs };
      } catch (err) {
        if (aborted(err)) throw err;
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
    const track = prev === undefined && isLive ? align(parsed, ref) : parsed;
    resolved.set(partial.id, track);
    return track;
  };

  // --- tracks ----------------------------------------------------------------------------------

  const levels = (): AbrLevel[] => variants.map((v, i) => ({ id: `video-${i}`, bitrate: v.bandwidth, ...opt('width', v.width), ...opt('height', v.height) }));

  const describe = (): void => {
    const vIndex = videoLane()?.index;
    const aIndex = lanes.find((l) => l.type === 'audio')?.index ?? 0;
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
  const videoLane = (): Lane | undefined => lanes.find((l) => l.type === 'video');
  /** DVR window on the media timeline. */
  const window = (): { start: number; end: number } | undefined => {
    const lane = videoLane();
    if (lane === undefined || offset === undefined || lane.track.segments.length === 0) return undefined;
    return { start: (lane.track.segments[0] as Segment).startTime + offset, end: lastEnd(lane.track) + offset };
  };
  const aheadOf = (type: Kind): number => {
    const t = media.currentTime;
    return (sink?.buffered(type).find(([a, b]) => a <= t + 0.1 && t < b)?.[1] ?? t) - t;
  };

  /** From the first media segment: media - playlist time, and the start position on the element. */
  const establish = (lane: Lane, seg: Segment, data: ArrayBuffer): void => {
    if (offset !== undefined || lane.timing === undefined) return;
    const bmdt = readBaseMediaDecodeTime(data, lane.timing.trackId);
    offset = bmdt === undefined ? 0 : bmdt / lane.timing.timescale - seg.startTime;
    const s = sink as MseSink;
    if (!isLive && Number.isFinite(lane.track.duration)) {
      try {
        s.mediaSource.duration = offset + lane.track.duration;
      } catch {
        // Set again by the appends.
      }
    }
  };

  // --- lanes -----------------------------------------------------------------------------------

  const appendInit = async (lane: Lane, run: number): Promise<boolean> => {
    const init = lane.track.initialization;
    if (init === undefined || init.url === '') throw unsupported('no EXT-X-MAP');
    const key = `${init.url}#${init.byteRange?.start ?? ''}`;
    if (lane.initKey !== key || lane.init === undefined) {
      const { data } = await get(init, 'init');
      if (run !== epoch) return false;
      lane.init = new Uint8Array(data);
      lane.initKey = key;
      const info = findMediaTrack(data, lane.type === 'video' && lane.track.type === 'video' ? 'vide' : 'soun');
      lane.timing = info;
    }
    await (sink as MseSink).init([{ type: lane.type, mimeType: buildMimeCodec(lane.track), data: lane.init }]);
    lane.needsInit = false;
    return true;
  };

  /** ABR or the manual choice, before the next video segment is picked. */
  const chooseVariant = async (lane: Lane, run: number): Promise<void> => {
    let target = requested ?? lane.index;
    if (requested === undefined && driver !== undefined && driver.canEstimate && variants.length > 1) {
      const meta = getMediaPlaylistMetadata(lane.track);
      const d = driver.decide({ levels: levels(), current: lane.index, bufferLevel: aheadOf('video'), segmentDuration: meta?.targetDuration ?? 6, live: isLive, lowLatency: false, bufferTarget: forwardS });
      if (d.engineLevel >= 0) target = d.engineLevel;
      if (target !== lane.index) switchReason = `abr: ${d.reason}`;
    }
    if (target === lane.index) return;
    const track = await resolve(variants[target] as PartiallyResolvedVideoTrack, lane.track);
    if (run !== epoch) return;
    lane.index = target;
    lane.track = track;
    lane.needsInit = true;
    lane.ended = false;
    driver?.applied(target, levels());
    describe();
    bus.emit('quality-change', { id: `video-${target}`, auto: requested === undefined, reason: requested === undefined ? switchReason : 'manual' });
  };

  /** One segment for `lane`; false when there is nothing to do right now. */
  const step = async (lane: Lane, run: number): Promise<boolean> => {
    const s = sink as MseSink;
    if (lane.type === 'video') await chooseVariant(lane, run);
    if (run !== epoch) return true;
    if (aheadOf(lane.type) >= forwardS) return false;
    const inLedger = new Set(s.segments(lane.type).map((x) => x.id));
    const buffered = lane.track.segments.filter((x) => inLedger.has(x.id));
    const next = getSegmentsToLoad(lane.track.segments, buffered, playlistTime(), { bufferDuration: forwardS })[0];
    if (next === undefined) {
      const last = lane.track.segments[lane.track.segments.length - 1];
      if (!isLive && last !== undefined && inLedger.has(last.id)) {
        lane.ended = true;
        if (!endSignalled && lanes.every((l) => l.ended)) {
          endSignalled = true;
          s.endOfStream();
        }
      }
      return false;
    }
    if (lane.needsInit && !(await appendInit(lane, run))) return true;
    const kind: CmcdObjectKind = lane.type === 'audio' ? 'audio' : lane.track.codecs !== undefined && lane.track.codecs.length > 1 ? 'muxed' : 'video';
    const { data, ms, ttfbMs } = await get(next, kind, { durationS: next.duration, bitrateBps: lane.track.bandwidth });
    if (run !== epoch) return true;
    driver?.sampleDownload(ms, data.byteLength, ttfbMs);
    if (driver?.canEstimate === true) {
      const b = driver.bandwidth;
      bus.emit('bandwidth', { estimate: b.estimate, fast: b.fast, slow: b.slow });
    }
    const first = offset === undefined;
    establish(lane, next, data);
    const o = offset ?? 0;
    await s.append(lane.type, new Uint8Array(data), { id: next.id, start: next.startTime + o, end: segEnd(next) + o, level: lane.index });
    // The start position, once the first segment is in (so the seek finds it buffered).
    if (first && offset !== undefined && Math.abs(media.currentTime - (startAt + offset)) > 0.01) media.currentTime = startAt + offset;
    if (lane.type === 'video') driver?.segmentAppended();
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
      if (!s.streaming) {
        await s.whenStreaming();
        continue;
      }
      const e = epoch;
      let busy: boolean;
      try {
        busy = await step(lane, e);
      } catch (err) {
        if (aborted(err) && e !== epoch) continue;
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
      l.needsInit = true;
      l.ended = false;
    }
    endSignalled = false;
    driver?.reset();
  };

  return {
    formatId: 'hls',
    get tracks() {
      return tracks;
    },
    get latency() {
      return isLive ? live?.latency : undefined;
    },
    get targetLatency() {
      return isLive ? live?.targetLatency : undefined;
    },
    get mms() {
      return managed;
    },
    async load() {
      const url = ctx.source.src;
      if (typeof url !== 'string') throw fatal('other', 'unsupportedSource', 'HLS plays playlist URLs');
      const masterUrl = new URL(url, typeof location === 'object' ? location.href : undefined).href;
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
      variants = allVariants.filter(playable);
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
      if (destroyed) return;
      isLive = !Number.isFinite(vTrack.duration);
      // Lean rule stack (Throughput + InsufficientBuffer): the engine chunk budget (ADR-010 §3).
      if (variants.length > 1) driver = createAbrDriverWith(createLeanAbrController());
      await s.ready;
      if (destroyed) return;
      const lane = (type: Kind, index: number, track: ResolvedTrack): Lane => ({ type, index, track, init: undefined, initKey: undefined, needsInit: true, ended: false, timing: undefined });
      lanes.push(lane('video', 0, vTrack));
      if (aTrack !== undefined) lanes.push(lane('audio', startAudio, aTrack));
      describe();
      bus.emit('quality-change', { id: 'video-0', auto: true, reason: 'start (first variant)' });
      if (isLive) {
        try {
          s.mediaSource.duration = Number.POSITIVE_INFINITY;
        } catch {
          // Some engines reject Infinity before the first SourceBuffer.
        }
        const { startLive } = await import('./live.js');
        if (destroyed) return;
        live = startLive({
          media,
          mediaSource: s.mediaSource,
          ...opt('targetLatency', options.targetLatency),
          track: () => (videoLane() as Lane).track,
          window,
          // Reloads the playing renditions (a switch in flight keeps its new track).
          refresh: () =>
            Promise.all(
              lanes.map(async (lane) => {
                const before = lane.track;
                const next = await resolve((lane.type === 'video' ? variants : audios)[lane.index] as Partial, before);
                if (lane.track === before) lane.track = next;
                return [before, next] as const;
              }),
            ),
          // ENDLIST: the event became VOD; endOfStream sets the duration where the media ends.
          ended: () => (isLive = false),
        });
        startAt = live.startAt;
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
      if (requested === undefined || lane === undefined || sink === undefined || requested === lane.index) return;
      const from = sink.segments('video').find((x) => x.start >= media.currentTime + 1)?.start;
      if (from === undefined) return;
      epoch++;
      sink.abort('video');
      lane.needsInit = true;
      lane.ended = false;
      endSignalled = false;
      void sink.remove('video', from, Number.POSITIVE_INFINITY).catch(fail);
    },
    selectAudioTrack(id) {
      const index = Number(id.replace(/^audio-/, ''));
      const lane = lanes.find((l) => l.type === 'audio');
      if (lane === undefined || !Number.isInteger(index) || index === lane.index || audios[index] === undefined) return;
      const run0 = ++epoch;
      sink?.abort('audio');
      void (async () => {
        const track = await resolve(audios[index] as PartiallyResolvedAudioTrack, videoLane()?.track);
        if (run0 !== epoch) return;
        lane.index = index;
        lane.track = track;
        lane.needsInit = true;
        lane.ended = false;
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
      if (partial === undefined) return;
      const pick = selectedText;
      void import('./subtitles.js').then(({ loadSubtitles }) => {
        if (destroyed || selectedText !== pick) return;
        stopText = loadSubtitles({
          media,
          aheadS: forwardS,
          live: () => isLive,
          // Live: the subtitle playlist moves with the stream, so it is re-read each time.
          segments: async () => {
            if (isLive) resolved.delete(partial.id);
            return (await resolve(partial, videoLane()?.track)).segments;
          },
          fetchText: async (seg) => new TextDecoder().decode((await get(seg, 'caption')).data),
          playlistTime,
          offset: () => offset ?? 0,
          cues: (cues) => {
            if (selectedText === pick) bus.emit('text-cues', { trackId: pick as string, cues });
          },
          // Subtitles are not worth stopping playback for.
          error: (err) => aborted(err) || bus.emit('error', createError({ type: 'other', details: 'subtitleLoadError', fatal: false, recoverable: true, message: String(err), cause: err })),
        });
      });
    },
    seekToLive: () => live?.seekToLive(),
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      destroyed = true;
      epoch++;
      abort.abort();
      stopText?.();
      live?.destroy();
      media.removeEventListener('seeking', onSeeking);
      sink?.destroy();
      sink = undefined;
      bus.clear();
    },
  };
}
