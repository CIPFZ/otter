// MP4 Range engine (ADR-007 §4): progressive MP4 over MSE. mp4box.js (L1) parses moov and cuts
// keyframe-aligned fMP4 segments; the files are read with Range requests on demand. Renditions of
// one programme (keyframes on the same timestamps) switch at a keyframe boundary: the target
// file's init segment, then its segments from that time, appended after what is buffered. Nothing
// is flushed, so playback never waits (the "seamless" of ADR-007 §4). The segmenting strategy
// follows xgplayer-mp4's (REUSE §3, read, not copied); ABR is the pipeline rule stack.

import { createError, createEventBus, type OtterError } from '@otter-player/core';
import type { Engine, EngineContext, EngineEvents, Mp4Rendition, TrackList, VideoTrack } from '@otter-player/media';
import { createMseSink, type MseSink, type SinkInit } from '@otter-player/engine-pipeline';
import type { AbrDriver, AbrLevel } from '@otter-player/pipeline';
import type { ISOFile, Movie } from 'mp4box';

type Mp4Box = typeof import('mp4box');

/** Seconds per segment (keyframe aligned: a segment never starts mid-GOP). */
const SEGMENT_S = 2;
/** Bytes per Range request: about this many seconds of the file, within the bounds below. */
const CHUNK_S = 4;
const CHUNK_MIN = 64 * 1024;
const CHUNK_MAX = 1024 * 1024;
/** Default: stop reading while this much is buffered ahead, seconds (hls.js maxBufferLength). */
const MAX_AHEAD_S = 30;

export interface Mp4RangeEngineOptions {
  /** Seconds buffered ahead before reading pauses. A switch applies to what is not buffered yet. */
  readonly maxBufferAheadS?: number;
}
/** File head read first: ftyp + moov of a faststart file fit in it. */
const HEAD = 64 * 1024;

interface Segment {
  readonly type: 'audio' | 'video';
  readonly data: Uint8Array;
}

/** One rendition's file: its parser, size and init segments. */
interface Mp4File {
  readonly iso: ISOFile<'audio' | 'video', unknown>;
  readonly info: Movie;
  readonly size: number;
  readonly inits: readonly SinkInit[];
  /** Track id -> SourceBuffer type. */
  readonly types: ReadonlyMap<number, 'audio' | 'video'>;
  /** Bytes per Range request (CHUNK_S of this file). */
  readonly chunk: number;
  /** Segments cut by mp4box during the last appendBuffer. */
  readonly out: Segment[];
  readonly bitrate: number;
  readonly width: number;
  readonly height: number;
  readonly codec: string;
}

const fatal = (type: OtterError['type'], details: string, message: string, cause?: unknown): OtterError =>
  createError({ type, details, fatal: true, recoverable: type === 'network', message, ...(cause === undefined ? {} : { cause }) });

function mediaSourceCtor(preferManaged: boolean): { Ctor: typeof MediaSource; managed: boolean } | undefined {
  const g = globalThis as { ManagedMediaSource?: typeof MediaSource; MediaSource?: typeof MediaSource };
  if (g.ManagedMediaSource !== undefined && (preferManaged || g.MediaSource === undefined)) return { Ctor: g.ManagedMediaSource, managed: true };
  return g.MediaSource === undefined ? undefined : { Ctor: g.MediaSource, managed: false };
}

const bufferedEnd = (t: TimeRanges, at: number): number => {
  for (let i = 0; i < t.length; i++) if (t.start(i) <= at + 0.1 && at < t.end(i)) return t.end(i);
  return at;
};

export function createMp4RangeEngine(ctx: EngineContext, options: Mp4RangeEngineOptions = {}): Engine {
  const maxAhead = options.maxBufferAheadS ?? MAX_AHEAD_S;
  const bus = createEventBus<EngineEvents>();
  const media = ctx.media;
  const renditions: readonly Mp4Rendition[] =
    ctx.source.renditions !== undefined && ctx.source.renditions.length > 0 ? ctx.source.renditions : [{ src: ctx.source.src as string }];
  const files = new Map<number, Promise<Mp4File>>();
  const abort = new AbortController();
  let mp4box: Mp4Box | undefined;
  let sink: MseSink | undefined;
  let driver: AbrDriver | undefined;
  let tracks: TrackList = { video: [], audio: [], text: [], quality: 'opaque', requestedQuality: 'auto' };
  let managed = false;
  let destroyed = false;
  /** Rendition whose segments are being appended. */
  let current = Math.max(0, renditions.findIndex((r) => r.src === ctx.source.src));
  /** Manual choice, or undefined for ABR. */
  let requested: number | undefined;
  /** Next file position to read in the current rendition. */
  let position = 0;
  /** Bumped by seeks and switches: a running read loop stops when it changes. */
  let epoch = 0;
  let pumping = false;
  let ended = false;
  let switchReason = 'start';

  const range = async (src: string, start: number, end?: number): Promise<{ data: ArrayBuffer; size: number }> => {
    const began = performance.now();
    const headers: Record<string, string> = { ...ctx.source.headers, Range: `bytes=${start}-${end === undefined ? '' : end}` };
    const cmcd = ctx.cmcd?.decorate({ url: src, kind: 'muxed' });
    let res: Response;
    try {
      res = await fetch(cmcd?.url ?? src, { headers: { ...headers, ...cmcd?.headers }, signal: abort.signal });
    } catch (err) {
      throw fatal('network', 'rangeLoadError', String(err), err);
    }
    if (res.status !== 206 && res.status !== 200) throw fatal('network', 'rangeLoadError', `HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    // Content-Range: bytes 0-65535/622306; a 200 is the whole file.
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? (res.status === 200 ? data.byteLength : Number.NaN));
    const ms = performance.now() - began;
    driver?.sampleDownload(ms, data.byteLength);
    if (driver !== undefined && driver.canEstimate) {
      const b = driver.bandwidth;
      bus.emit('bandwidth', { estimate: b.estimate, fast: b.fast, slow: b.slow });
    }
    return { data, size: total };
  };

  /** Reads moov (head first, then the tail when moov is at the end) and prepares segmentation. */
  const open = (index: number): Promise<Mp4File> => {
    const known = files.get(index);
    if (known !== undefined) return known;
    const opened = (async (): Promise<Mp4File> => {
      const box = mp4box as Mp4Box;
      const r = renditions[index] as Mp4Rendition;
      const iso = box.createFile() as ISOFile<'audio' | 'video', unknown>;
      let info: Movie | undefined;
      let error: string | undefined;
      iso.onReady = (i) => (info = i);
      iso.onError = (_module, message) => (error = message);
      const out: Segment[] = [];
      iso.onSegment = (id, user, buffer, nextSample) => {
        out.push({ type: user, data: new Uint8Array(buffer) });
        iso.releaseUsedSamples(id, nextSample);
      };
      let { data, size } = await range(r.src, 0, HEAD - 1);
      let at = 0;
      for (let guard = 0; info === undefined && error === undefined && guard < 16; guard++) {
        const next = iso.appendBuffer(box.MP4BoxBuffer.fromArrayBuffer(data, at));
        if (info !== undefined || !(next < size)) break;
        // moov after mdat: mp4box asks for the position of the next top-level box.
        at = next;
        ({ data } = await range(r.src, at, Math.min(size, at + Math.max(HEAD, CHUNK_MAX)) - 1));
      }
      if (info === undefined) throw fatal('media', 'mp4MoovNotFound', error ?? `no moov in ${r.src}`);
      const movie = info;
      // mp4box 2.x cuts every track with the same sample count: ~SEGMENT_S of video frames.
      const v = movie.videoTracks[0];
      const nbSamples = v === undefined ? 50 : Math.max(1, Math.round((v.nb_samples / Math.max(v.duration / v.timescale, 0.001)) * SEGMENT_S));
      const types = new Map<number, 'audio' | 'video'>();
      for (const t of movie.tracks) {
        const type = movie.videoTracks.some((x) => x.id === t.id) ? 'video' : movie.audioTracks.some((x) => x.id === t.id) ? 'audio' : undefined;
        if (type === undefined) continue;
        types.set(t.id, type);
        iso.setSegmentOptions(t.id, type, { nbSamples, rapAlignement: type === 'video' });
      }
      const inits = iso.initializeSegmentation('per-track').map((s) => {
        const t = movie.tracks.find((x) => x.id === s.id);
        return { type: s.user, mimeType: `${s.user}/mp4; codecs="${t?.codec ?? ''}"`, data: new Uint8Array(s.buffer) };
      });
      iso.start();
      const video = movie.videoTracks[0];
      const seconds = movie.duration / movie.timescale;
      const bitrate = r.bitrate ?? (seconds > 0 ? Math.round((size * 8) / seconds) : 0);
      return {
        iso,
        info: movie,
        size,
        inits,
        types,
        chunk: Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, Math.round(((seconds > 0 ? (size * 8) / seconds : 0) / 8) * CHUNK_S))),
        out,
        bitrate,
        width: r.width ?? video?.video?.width ?? 0,
        height: r.height ?? video?.video?.height ?? 0,
        codec: video?.codec ?? '',
      };
    })();
    files.set(index, opened);
    return opened;
  };

  /** Positions every track (video on a keyframe); returns the file offset to read from. */
  const seekTracks = (f: Mp4File, times: Readonly<Record<'audio' | 'video', number>>): number => {
    let offset = Number.POSITIVE_INFINITY;
    for (const trak of f.iso.moov.traks) {
      const type = f.types.get(trak.tkhd.track_id);
      if (type !== undefined) offset = Math.min(offset, f.iso.seekTrack(times[type], type === 'video', trak).offset);
    }
    return Number.isFinite(offset) ? offset : position;
  };

  const levels = (): AbrLevel[] =>
    tracks.video.map((v) => ({ id: v.id, bitrate: v.bitrate ?? 0, ...(v.width === undefined ? {} : { width: v.width }), ...(v.height === undefined ? {} : { height: v.height }) }));

  const describe = async (): Promise<void> => {
    // Sizes and bitrates from the host when given, else from the files once opened.
    const known = await Promise.all(renditions.map((_, i) => (files.has(i) ? open(i) : Promise.resolve(undefined))));
    const video: VideoTrack[] = renditions.map((r, i) => {
      const f = known[i];
      const width = r.width ?? f?.width;
      const height = r.height ?? f?.height;
      const bitrate = r.bitrate ?? f?.bitrate;
      return {
        kind: 'video',
        id: `rendition-${i}`,
        selected: i === current,
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(bitrate === undefined ? {} : { bitrate }),
        ...(f?.codec === undefined || f.codec === '' ? {} : { codec: f.codec }),
      };
    });
    tracks = { video, audio: [], text: [], quality: renditions.length > 1 ? 'selectable' : 'opaque', requestedQuality: requested === undefined ? 'auto' : `rendition-${requested}` };
    bus.emit('tracks-change', tracks);
  };

  /** Target rendition for the next segment: the manual choice, else the ABR decision. */
  const target = (): number => {
    if (requested !== undefined) return requested;
    if (driver === undefined || renditions.length < 2 || !driver.canEstimate) return current;
    const ahead = bufferedEnd(media.buffered, media.currentTime) - media.currentTime;
    const d = driver.decide({ levels: levels(), current, bufferLevel: ahead, segmentDuration: SEGMENT_S, live: false, lowLatency: false, bufferTarget: maxAhead });
    if (d.engineLevel >= 0 && d.engineLevel !== current) switchReason = `abr: ${d.reason}`;
    return d.engineLevel >= 0 ? d.engineLevel : current;
  };

  /** Appends one Range chunk's worth of segments of the current rendition. */
  const step = async (run: number): Promise<boolean> => {
    const s = sink as MseSink;
    const next = target();
    if (next !== current) {
      // Switch at a keyframe: mp4box's video segments end on a keyframe, so the keyframe at or
      // before the end of the buffered video is where the new file takes over (its keyframe
      // replaces that one frame). Measured on the video SourceBuffer: the element's buffered is
      // the audio / video intersection, which can end mid-GOP.
      const f = await open(next);
      if (run !== epoch) return true;
      const t = media.currentTime;
      const end = (type: 'audio' | 'video'): number => s.buffered(type).find(([a, b]) => a <= t + 0.1 && t < b)?.[1] ?? t;
      await s.init(f.inits);
      // Per track: video from the keyframe at the video end, audio from the first frame after the
      // audio end (audio and video segments end at different times; one shared seek leaves a gap).
      position = seekTracks(f, { video: end('video'), audio: end('audio') + 0.001 });
      current = next;
      ended = false;
      driver?.applied(current, levels());
      await describe();
      bus.emit('quality-change', { id: `rendition-${current}`, auto: requested === undefined, reason: requested === undefined ? switchReason : 'manual' });
    }
    const f = await open(current);
    if (run !== epoch) return true;
    if (position >= f.size) {
      if (!ended) {
        ended = true;
        f.iso.flush();
        for (const seg of f.out.splice(0)) await s.append(seg.type, seg.data);
        s.endOfStream();
      }
      return false;
    }
    const src = (renditions[current] as Mp4Rendition).src;
    const { data } = await range(src, position, Math.min(f.size, position + f.chunk) - 1);
    if (run !== epoch) return true;
    const chunkStart = position;
    // No `last` flag: mp4box would then cut every remaining sample into its own segment; the end
    // of the file is flush() above.
    const next2 = f.iso.appendBuffer((mp4box as Mp4Box).MP4BoxBuffer.fromArrayBuffer(data, chunkStart));
    position = Number.isFinite(next2) && next2 > chunkStart ? next2 : chunkStart + data.byteLength;
    for (const seg of f.out.splice(0)) {
      if (run !== epoch) return true;
      await s.append(seg.type, seg.data);
      if (seg.type === 'video') driver?.segmentAppended();
    }
    return true;
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (!destroyed) {
        // ManagedMediaSource does not want data (background, buffer full): no Range requests.
        if (sink !== undefined && !sink.streaming) {
          await sink.whenStreaming();
          continue;
        }
        const ahead = bufferedEnd(media.buffered, media.currentTime) - media.currentTime;
        // Enough ahead, or the file is done (a seek or switch resets `ended`): check again soon.
        if (ahead > maxAhead || ended || !(await step(epoch))) await new Promise((r) => setTimeout(r, 250));
      }
    } catch (err) {
      if (!destroyed) bus.emit('error', err !== null && typeof err === 'object' && 'details' in err ? (err as OtterError) : fatal('media', 'mp4RangeError', String(err), err));
    } finally {
      pumping = false;
    }
  };

  const onSeeking = (): void => {
    const t = media.currentTime;
    // Already buffered: nothing to fetch yet.
    for (let i = 0; i < media.buffered.length; i++) if (media.buffered.start(i) <= t && t < media.buffered.end(i)) return;
    epoch++;
    ended = false;
    void open(current).then((f) => {
      position = f.iso.seek(t, true).offset;
      driver?.reset();
      void pump();
    });
  };

  return {
    formatId: 'mp4-range',
    get tracks() {
      return tracks;
    },
    get mms() {
      return managed;
    },
    async load() {
      if (renditions.some((r) => typeof r.src !== 'string')) throw fatal('other', 'unsupportedSource', 'Range loading needs URLs');
      const [box, pipeline] = await Promise.all([import('mp4box'), renditions.length > 1 ? import('@otter-player/pipeline') : undefined]);
      if (destroyed) return;
      mp4box = box;
      driver = pipeline?.createAbrDriver();
      const ms = mediaSourceCtor(ctx.mms);
      if (ms === undefined) throw fatal('media', 'engineUnsupported', 'no MediaSource here');
      managed = ms.managed;
      const s = createMseSink(ms.Ctor, { backBufferS: 30 });
      sink = s;
      media.src = s.url;
      const f = await open(current);
      await s.ready;
      if (destroyed) return;
      try {
        s.mediaSource.duration = f.info.duration / f.info.timescale;
      } catch {
        // Set again by the appends.
      }
      await s.init(f.inits);
      position = f.iso.seek(ctx.options.startTime ?? 0, true).offset;
      await describe();
      bus.emit('quality-change', { id: `rendition-${current}`, auto: true, reason: 'start' });
      // The other renditions' moov in the background: sizes and bitrates for the quality menu.
      void Promise.all(renditions.map((_, i) => open(i).catch(() => undefined))).then(() => {
        if (!destroyed) void describe();
      });
      // Resolve once the first segments are in, like the other engines resolve on media info.
      let first = true;
      while (first && !destroyed) {
        const more = await step(epoch);
        if (media.buffered.length > 0) first = false;
        if (!more) break;
      }
      bus.emit('first-segment', { at: performance.now() });
      media.addEventListener('seeking', onSeeking);
      void pump();
    },
    selectQuality(id) {
      if (id === 'auto') requested = undefined;
      else {
        const index = Number(id.replace(/^rendition-/, ''));
        if (Number.isInteger(index) && index >= 0 && index < renditions.length) requested = index;
      }
      void describe();
    },
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      destroyed = true;
      epoch++;
      abort.abort();
      media.removeEventListener('seeking', onSeeking);
      sink?.destroy();
      sink = undefined;
      bus.clear();
    },
  };
}
