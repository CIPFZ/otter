// Otter's own engine (ADR-007 §2): fetch-streamed bytes -> pipeline transmuxer (FLV / MPEG-TS ->
// fMP4) -> MSE sink, with the LiveController keeping live streams near the edge. Implements the
// same Engine contract as the hls.js / Shaka / mpegts.js adapters (ADR-003), so the session,
// backend-mse and QoE need no changes. The transmuxer and the LiveController load on demand.
// CEA-608 in the video's SEI is decoded here and delivered as in-band `text-cues` (one text
// track per caption channel that carries text), like hls.js and Shaka do for HLS / DASH.

import { createError, createEventBus, type OtterError, type Unsubscribe } from '@otter-player/core';
import { EMPTY_TRACKS, type AudioTrack, type Engine, type EngineContext, type EngineEvents, type InbandCue, type TextTrackInfo, type TrackList, type VideoTrack } from '@otter-player/media';
import type { Cea608Decoder, LiveController, LiveSample } from '@otter-player/pipeline';
import type { TransmuxResult, Transmuxer } from '@otter-player/pipeline/transmux';
import { createMseSink, type MseSink } from './mse-sink.js';

export { createMseSink, type MseSink, type MseSinkOptions, type SinkInit } from './mse-sink.js';

export interface PipelineEngineOptions {
  readonly type: 'flv' | 'ts';
  /** Live: latency to hold (buffer end minus playhead), seconds. */
  readonly targetLatency?: number;
  /** Seconds kept behind the playhead. */
  readonly backBufferS?: number;
  /** VOD: stop reading the stream while this much is buffered ahead, seconds. */
  readonly maxBufferAheadS?: number;
}

const ranges = (t: TimeRanges): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i < t.length; i++) out.push([t.start(i), t.end(i)]);
  return out;
};

const fatal = (type: OtterError['type'], details: string, message: string, cause?: unknown): OtterError =>
  createError({ type, details, fatal: true, recoverable: type === 'network', message, ...(cause === undefined ? {} : { cause }) });

function mediaSourceCtor(preferManaged: boolean): { Ctor: typeof MediaSource; managed: boolean } | undefined {
  const g = globalThis as { ManagedMediaSource?: typeof MediaSource; MediaSource?: typeof MediaSource };
  if (g.ManagedMediaSource !== undefined && (preferManaged || g.MediaSource === undefined)) return { Ctor: g.ManagedMediaSource, managed: true };
  return g.MediaSource === undefined ? undefined : { Ctor: g.MediaSource, managed: false };
}

export function createPipelineEngine(ctx: EngineContext, options: PipelineEngineOptions): Engine & { seekToLive(): void } {
  const bus = createEventBus<EngineEvents>();
  const media = ctx.media;
  const live = ctx.source.live ?? false;
  const abort = new AbortController();
  const offs: Unsubscribe[] = [];
  let tracks: TrackList = EMPTY_TRACKS;
  let sink: MseSink | undefined;
  let controller: LiveController | undefined;
  let managed = false;
  let destroyed = false;
  let cea608: Cea608Decoder | undefined;
  /** Caption data that arrived while the decoder chunk loads. */
  let pendingCaptions: TransmuxResult['captions'][number][] | undefined;
  /** Decoded cues per caption channel track (`cc1` ...), kept for a later selection. */
  const captionCues = new Map<string, Map<string, InbandCue>>();
  let selectedText: string | null = null;
  let videoTracks: VideoTrack[] = [];
  let audioTracks: AudioTrack[] = [];

  const sample = (): LiveSample => ({
    currentTime: media.currentTime,
    paused: media.paused,
    buffered: ranges(media.buffered),
    playbackRate: media.playbackRate,
    readyState: media.readyState,
  });

  const apply = (action: ReturnType<LiveController['sample']>): void => {
    if (action === undefined) return;
    if (action.type === 'seek') media.currentTime = action.to;
    else media.playbackRate = action.rate;
  };

  const listen = (type: string, h: () => void): void => {
    media.addEventListener(type, h);
    offs.push(() => media.removeEventListener(type, h));
  };

  const describe = (t: Transmuxer): void => {
    const info = t.info;
    const video: VideoTrack[] = info.hasVideo
      ? [
          {
            kind: 'video',
            id: 'pipeline-0',
            selected: true,
            ...(info.width === undefined ? {} : { width: info.width }),
            ...(info.height === undefined ? {} : { height: info.height }),
            ...(info.videoCodec === undefined ? {} : { codec: info.videoCodec }),
          },
        ]
      : [];
    const audio: AudioTrack[] = info.hasAudio ? [{ kind: 'audio', id: 'audio-0', selected: true, ...(info.audioCodec === undefined ? {} : { codec: info.audioCodec }) }] : [];
    videoTracks = video;
    audioTracks = audio;
    publish();
  };

  const publish = (): void => {
    const text: TextTrackInfo[] = [...captionCues.keys()].sort().map((id) => ({
      kind: 'text',
      id,
      role: 'captions',
      format: 'cea-608',
      label: id.toUpperCase(),
      selected: id === selectedText,
    }));
    tracks = { video: videoTracks, audio: audioTracks, text, quality: 'opaque', requestedQuality: 'auto' };
    bus.emit('tracks-change', tracks);
  };

  /** cc_data blocks -> cues; a channel becomes a text track with its first caption. */
  const onCaptions = (captions: TransmuxResult['captions']): void => {
    if (captions.length === 0 || destroyed) return;
    if (cea608 === undefined) {
      // The 608 decoder is its own chunk, loaded with the first caption data.
      if (pendingCaptions === undefined) {
        pendingCaptions = [];
        void import('@otter-player/pipeline/captions').then(({ createCea608Decoder }) => {
          if (destroyed) return;
          cea608 = createDecoder(createCea608Decoder);
          const queued = pendingCaptions ?? [];
          pendingCaptions = undefined;
          for (const c of queued) cea608.push(c.time, c.data);
        });
      }
      pendingCaptions.push(...captions);
      return;
    }
    for (const c of captions) cea608.push(c.time, c.data);
  };

  const createDecoder = (create: typeof import('@otter-player/pipeline/captions').createCea608Decoder): Cea608Decoder =>
    create((channel, cues) => {
      const id = `cc${channel}`;
      let store = captionCues.get(id);
      const isNew = store === undefined;
      if (store === undefined) captionCues.set(id, (store = new Map()));
      for (const c of cues) store.set(c.id, c);
      // Live captions never end: keep the most recent ones.
      if (store.size > 2000) for (const k of [...store.keys()].slice(0, store.size - 2000)) store.delete(k);
      if (isNew) publish();
      if (id === selectedText) bus.emit('text-cues', { trackId: id, cues });
    });

  return {
    formatId: options.type,
    get tracks() {
      return tracks;
    },
    get latency() {
      if (!live || media.buffered.length === 0) return undefined;
      return Math.max(0, media.buffered.end(media.buffered.length - 1) - media.currentTime);
    },
    get mms() {
      return managed;
    },
    async load() {
      const url = ctx.source.src;
      if (typeof url !== 'string') throw fatal('other', 'unsupportedSource', 'the Otter pipeline needs a URL');
      const [{ createFlvTransmuxer, createTsTransmuxer }, { createLiveController }] = await Promise.all([
        import('@otter-player/pipeline/transmux'),
        import('@otter-player/pipeline'),
      ]);
      if (destroyed) return;
      const ms = mediaSourceCtor(ctx.mms);
      if (ms === undefined) throw fatal('media', 'engineUnsupported', 'no MediaSource here');
      managed = ms.managed;
      const s = createMseSink(ms.Ctor, { backBufferS: options.backBufferS ?? 30 });
      sink = s;
      media.src = s.url;
      await s.ready;
      if (destroyed) return;
      if (live) {
        try {
          s.mediaSource.duration = Number.POSITIVE_INFINITY;
        } catch {
          // Some engines reject Infinity before the first SourceBuffer; harmless.
        }
        const lc = createLiveController(options.targetLatency === undefined ? {} : { targetLatency: options.targetLatency });
        controller = lc;
        listen('timeupdate', () => apply(lc.sample(sample())));
        listen('progress', () => apply(lc.sample(sample())));
        listen('canplay', () => apply(lc.sample(sample(), { canPlay: true })));
        listen('stalled', () => apply(lc.sample(sample(), { stalled: true })));
      }

      const t = options.type === 'flv' ? createFlvTransmuxer() : createTsTransmuxer();
      // CMCD (ADR-005 §2): one long request, decorated once with the muxed object type.
      const cmcd = ctx.cmcd?.decorate({ url, kind: 'muxed' });
      let response: Response;
      try {
        response = await fetch(cmcd?.url ?? url, { headers: { ...ctx.source.headers, ...cmcd?.headers }, signal: abort.signal });
      } catch (err) {
        if (destroyed) return;
        throw fatal('network', 'streamLoadError', String(err), err);
      }
      if (!response.ok || response.body === null) throw fatal('network', 'streamLoadError', `HTTP ${response.status}`);
      const reader = response.body.getReader();

      // Resolves once the first init segment and fragment are in MSE (tracks known), like the
      // adapters resolve on media info.
      let resolveReady: () => void = () => undefined;
      let rejectReady: (e: OtterError) => void = () => undefined;
      let ready = false;
      const readyPromise = new Promise<void>((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
      });
      const fail = (error: OtterError): void => {
        if (!ready) {
          ready = true;
          rejectReady(error);
        } else {
          bus.emit('error', error);
        }
      };

      let seenErrors = 0;
      let firstSegment = false;
      let windowBytes = 0;
      let windowStart = performance.now();
      let lastEvict = 0;

      const push = async (r: TransmuxResult): Promise<void> => {
        for (const e of t.errors.slice(seenErrors)) {
          seenErrors++;
          if (e.fatal) throw fatal('media', e.details, e.message);
          bus.emit('error', createError({ type: 'media', details: e.details, fatal: false, recoverable: true, message: e.message }));
        }
        if (r.init.length > 0) await s.init(r.init);
        if (r.init.length > 0) describe(t);
        onCaptions(r.captions);
        for (const f of r.fragments) {
          await s.append(f.type, f.data);
          if (!firstSegment) {
            firstSegment = true;
            bus.emit('first-segment', { at: performance.now() });
          }
        }
        if (!ready && firstSegment && tracks !== EMPTY_TRACKS) {
          ready = true;
          // VOD: the fragments keep the source timestamps (MPEG-TS often starts at 1.4 s), so start
          // at the requested position or the first buffered one; live is the LiveController's job.
          if (!live) {
            const first = media.buffered.length > 0 ? media.buffered.start(0) : 0;
            media.currentTime = Math.max(first, ctx.options.startTime ?? 0);
          }
          resolveReady();
        }
      };

      const pump = async (): Promise<void> => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (destroyed) return;
            if (done) break;
            windowBytes += value.byteLength;
            const now = performance.now();
            if (now - windowStart >= 1000) {
              const estimate = (windowBytes * 8 * 1000) / (now - windowStart);
              bus.emit('bandwidth', { estimate, fast: estimate, slow: estimate });
              windowBytes = 0;
              windowStart = now;
            }
            await push(t.push(value));
            if (live && now - lastEvict > 5000) {
              lastEvict = now;
              await s.evict(media.currentTime);
            }
            // VOD read-ahead limit: wait for the playhead before reading more.
            while (!live && !destroyed && (media.buffered.length > 0 ? media.buffered.end(media.buffered.length - 1) - media.currentTime : 0) > (options.maxBufferAheadS ?? 60)) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
          await push(t.flush());
          s.endOfStream();
          if (!ready) fail(fatal('media', 'noMediaFound', 'the stream ended before any media was found'));
        } catch (err) {
          if (destroyed) return;
          fail(err !== null && typeof err === 'object' && 'details' in err ? (err as OtterError) : fatal('media', 'pipelineError', String(err), err));
        }
      };
      void pump();
      await readyPromise;
    },
    selectQuality() {
      // One rendition per FLV / TS stream.
    },
    selectTextTrack(id) {
      selectedText = id;
      publish();
      const known = id === null ? undefined : captionCues.get(id);
      if (id !== null && known !== undefined && known.size > 0) bus.emit('text-cues', { trackId: id, cues: [...known.values()] });
    },
    seekToLive() {
      if (controller !== undefined) apply(controller.seekToLive(sample()));
    },
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      destroyed = true;
      abort.abort();
      for (const off of offs.splice(0)) off();
      sink?.destroy();
      sink = undefined;
      bus.clear();
    },
  };
}
export { withAdapterFallback } from './fallback.js';
