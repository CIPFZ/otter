// mediabunny (L1) as the WebCodecs backend's Demuxer (ADR-008 §2): a local File / Blob
// (format-file: MP4 / MOV / WebM / MKV / MPEG-TS / Ogg ...) or an HLS playlist URL (format-hls,
// when MSE cannot play the codec, e.g. HEVC). Formats load this package on demand. Container
// timestamps are media time as they are (like <video>); packets go out with a copied, transferable
// ArrayBuffer. createError comes from the caller: a value import shared by a format's entry and
// this lazily loaded package would make the entry's module graph side-effectful
// (scripts/check-side-effects.ts).

import type { createError as CreateError } from '@otter-player/core';
import type { DecodeSetup, Demuxer, DemuxDownload, DemuxInfo, DemuxVideoTrack, EncodedChunk, PacketStream } from '@otter-player/media';
import type { EncodedPacket, EncodedPacketSink, Input, InputAudioTrack, InputVideoTrack } from 'mediabunny';

/** mediabunny itself loads with the first source (engine libraries only behind import(), ADR-004 §2). */
const lib = (): Promise<typeof import('mediabunny')> => import('mediabunny');

const copy = (b: AllowSharedBufferSource): ArrayBuffer => {
  const view = ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
  return view.slice().buffer;
};

const toChunk = (p: EncodedPacket): EncodedChunk => ({
  type: p.type,
  timestamp: Math.round(p.timestamp * 1e6),
  duration: Math.round(p.duration * 1e6),
  data: p.data.slice().buffer,
});

let createError: typeof CreateError;

const muxError = (details: string, cause: unknown): Error =>
  createError({ type: 'mux', details, fatal: true, recoverable: false, message: cause instanceof Error ? cause.message : String(cause), cause });

/**
 * Packets from `start` in decode order; stops when `signal` aborts. One packet at a time
 * (getNextPacket), not `sink.packets()`: that iterator preloads ahead on its own, which for HLS
 * downloads most of a rendition at once and leaves the backend's read-ahead (ABR's buffer, quality
 * switches) nothing to decide.
 */
async function* stream(sink: EncodedPacketSink, start: EncodedPacket | null, signal: AbortSignal): AsyncGenerator<EncodedChunk> {
  let p = start;
  while (p !== null && !signal.aborted) {
    yield toChunk(p);
    p = await sink.getNextPacket(p, { verifyKeyPackets: false });
  }
}

async function videoSetup(track: InputVideoTrack): Promise<DecodeSetup> {
  const c = await track.getDecoderConfig();
  if (c === null) throw muxError('codecUnknown', `video codec ${String(await track.getCodec())} has no decoder config`);
  return {
    codec: c.codec,
    ...(c.codedWidth === undefined ? {} : { codedWidth: c.codedWidth }),
    ...(c.codedHeight === undefined ? {} : { codedHeight: c.codedHeight }),
    ...(c.description === undefined ? {} : { description: copy(c.description) }),
    ...(c.colorSpace === undefined ? {} : { colorSpace: c.colorSpace }),
  };
}

async function audioSetup(track: InputAudioTrack): Promise<DecodeSetup> {
  const c = await track.getDecoderConfig();
  if (c === null) throw muxError('codecUnknown', `audio codec ${String(await track.getCodec())} has no decoder config`);
  return {
    codec: c.codec,
    sampleRate: c.sampleRate,
    numberOfChannels: c.numberOfChannels,
    ...(c.description === undefined ? {} : { description: copy(c.description) }),
  };
}

export interface OpenOptions {
  readonly signal: AbortSignal;
  readonly createError: typeof CreateError;
  /** Request headers for URL sources (HLS playlists and segments). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A local File / Blob in any container mediabunny reads. */
export async function openBlob(blob: Blob, options: OpenOptions): Promise<Demuxer> {
  const mb = await lib();
  return open(mb, new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS }), options);
}

/**
 * An HLS playlist (multivariant or media). Every video variant is offered (`info.videoTracks`,
 * switchable with `openVideo`); the audio paired with the primary variant plays throughout.
 * Media downloads are reported for ABR.
 */
export async function openHls(url: string, options: OpenOptions): Promise<Demuxer> {
  const mb = await lib();
  const downloads = new Set<(d: DemuxDownload) => void>();
  const input = new mb.Input({
    source: new mb.UrlSource(url, {
      ...(options.headers === undefined ? {} : { requestInit: { headers: { ...options.headers } } }),
      fetchFn: measuredFetch(downloads),
    }),
    formats: mb.HLS_FORMATS,
    // Media time from the playlist, not wall-clock (EXT-X-PROGRAM-DATE-TIME).
    formatOptions: { hls: { offsetTimestampsByDateTime: false } },
  });
  return open(mb, input, options, downloads);
}

/** Responses smaller than this are playlists or init segments, not media for bandwidth samples. */
const MIN_SAMPLE_BYTES = 16_000;

/**
 * fetch that reports each media download (bytes, transfer time, time to first byte), when the
 * body ends, when its declared length is read, or when the reader cancels it (mediabunny stops
 * reading once it has what it needs).
 */
function measuredFetch(listeners: Set<(d: DemuxDownload) => void>): typeof fetch {
  return async (input, init) => {
    const t0 = performance.now();
    const res = await fetch(input, init);
    const ttfbMs = performance.now() - t0;
    if (res.body === null) return res;
    const reader = res.body.getReader();
    // Readers may stop at the declared length without reading on to the end of the stream.
    const length = Number(res.headers.get('content-length') ?? Number.NaN);
    let bytes = 0;
    let reported = false;
    const report = (): void => {
      if (reported || bytes < MIN_SAMPLE_BYTES) return;
      reported = true;
      const d: DemuxDownload = { bytes, ms: performance.now() - t0, ttfbMs };
      for (const l of listeners) l(d);
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          report();
          controller.close();
          return;
        }
        bytes += value.byteLength;
        controller.enqueue(value);
        if (bytes >= length) report();
      },
      cancel(reason) {
        report();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

async function describeVideo(track: InputVideoTrack, frameRate: number | undefined): Promise<DemuxVideoTrack> {
  const setup = await videoSetup(track);
  const bitrate = (await track.getBitrate().catch(() => null)) ?? undefined;
  return {
    id: track.id,
    codec: setup.codec,
    setup,
    width: await track.getSquarePixelWidth(),
    height: await track.getSquarePixelHeight(),
    ...(bitrate === undefined ? {} : { bitrate }),
    ...(frameRate === undefined ? {} : { frameRate }),
  };
}

async function open(mb: typeof import('mediabunny'), input: Input, options: OpenOptions, downloads?: Set<(d: DemuxDownload) => void>): Promise<Demuxer> {
  createError = options.createError;
  const signal = options.signal;
  try {
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    if (video === null && audio === null) throw muxError('noTracks', 'no audio or video track');
    const used = [video, audio].filter((t) => t !== null);
    const [startTime, end] = await Promise.all([input.getFirstTimestamp(used), input.computeDuration(used)]);
    const aSetup = audio === null ? null : await audioSetup(audio);
    const stats = video === null ? null : await video.computePacketStats(120).catch(() => null);
    const frameRate = stats === null || !(stats.averagePacketRate > 0) ? undefined : stats.averagePacketRate;
    // Every variant with a usable decoder config (others are left out, not fatal).
    const inputs = video === null ? [] : await input.getVideoTracks();
    const variants: { track: InputVideoTrack; info: DemuxVideoTrack }[] = [];
    for (const t of inputs) {
      try {
        variants.push({ track: t, info: await describeVideo(t, frameRate) });
      } catch {
        // No decoder config for this variant.
      }
    }
    const primary = video === null ? undefined : variants.find((v) => v.track === video);
    if (video !== null && primary === undefined) await videoSetup(video);
    const refresh = video === null ? null : await video.getLiveRefreshInterval().catch(() => null);
    const info: DemuxInfo = {
      duration: end,
      startTime,
      video: primary?.info ?? null,
      audio:
        audio === null || aSetup === null
          ? null
          : { id: audio.id, codec: aSetup.codec, setup: aSetup, sampleRate: await audio.getSampleRate(), channels: await audio.getNumberOfChannels() },
      ...(variants.length > 1 ? { videoTracks: variants.map((v) => v.info) } : {}),
      ...(refresh === null || !(refresh > 0) ? {} : { segmentDuration: refresh }),
    };
    const videoSinks = new Map<number, EncodedPacketSink>();
    const videoSink = (id: number): EncodedPacketSink => {
      let s = videoSinks.get(id);
      if (s === undefined) {
        const v = variants.find((x) => x.info.id === id);
        if (v === undefined) throw muxError('noTrack', `no video track ${id}`);
        s = new mb.EncodedPacketSink(v.track);
        videoSinks.set(id, s);
      }
      return s;
    };
    const audioSink = audio === null ? null : new mb.EncodedPacketSink(audio);
    const sinkOf = (track: 'video' | 'audio'): EncodedPacketSink => {
      const s = track === 'video' ? (primary === undefined ? null : videoSink(primary.info.id)) : audioSink;
      if (s === null) throw muxError('noTrack', `no ${track} track`);
      return s;
    };
    return {
      info,
      packets(track): PacketStream {
        const sink = sinkOf(track);
        return {
          async *[Symbol.asyncIterator]() {
            yield* stream(sink, await sink.getFirstPacket(), signal);
          },
        };
      },
      async seek(track, time) {
        const sink = sinkOf(track);
        // The last keyframe at or before `time`; before the first one, the first packet.
        const key = (await sink.getKeyPacket(time, { verifyKeyPackets: true })) ?? (await sink.getFirstKeyPacket());
        return stream(sink, key, signal);
      },
      async openVideo(id, time, edge) {
        const sink = videoSink(id);
        let key = (await sink.getKeyPacket(time, { verifyKeyPackets: true })) ?? (await sink.getFirstKeyPacket());
        // 'after': the first keyframe at or after `time` (half a millisecond of tolerance).
        if (edge === 'after' && key !== null && key.timestamp < time - 0.0005) key = await sink.getNextKeyPacket(key, { verifyKeyPackets: true });
        if (key === null) return null;
        return { start: key.timestamp, packets: stream(sink, key, signal) };
      },
      ...(downloads === undefined
        ? {}
        : {
            onDownload(h: (d: DemuxDownload) => void) {
              downloads.add(h);
              return () => downloads.delete(h);
            },
          }),
      destroy() {
        downloads?.clear();
        input.dispose();
      },
    };
  } catch (err) {
    input.dispose();
    if ((err as { details?: unknown } | null)?.details !== undefined) throw err;
    throw muxError('demuxFailed', err);
  }
}

/** Packets kept for new readers of a live stream (a seek, the audio started at the first gesture). */
const LIVE_HISTORY_S = 15;

/**
 * A live MPEG-TS stream over HTTP (ADR-013 §7: surveillance walls): read as it arrives through
 * mediabunny's ReadableStreamSource (unsized, sequential; its cache keeps the last 32 MiB), one
 * reader per track, fanned out to the backend's readers. The duration is infinite; media time 0 is
 * the first video keyframe.
 */
export async function openLiveTs(url: string, options: OpenOptions): Promise<Demuxer> {
  const mb = await lib();
  createError = options.createError;
  const { createLiveFanout } = await import('@otter-player/media');
  let res: Response;
  try {
    // no-store: Firefox holds a second request for the same cacheable URL until the first one is
    // complete, which an endless stream never is (RESEARCH §1).
    res = await fetch(url, { cache: 'no-store', signal: options.signal, ...(options.headers === undefined ? {} : { headers: { ...options.headers } }) });
    if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status} for ${url}`);
  } catch (err) {
    throw createError({ type: 'network', details: 'tsRequestFailed', fatal: true, recoverable: true, message: err instanceof Error ? err.message : String(err), cause: err });
  }
  const input = new mb.Input({ source: new mb.ReadableStreamSource(res.body, { handleUnhandledError: () => undefined }), formats: [mb.MPEG_TS] });
  const fanout = createLiveFanout(LIVE_HISTORY_S);
  let info: DemuxInfo;
  let video: InputVideoTrack | null;
  let audio: InputAudioTrack | null;
  try {
    video = await input.getPrimaryVideoTrack();
    audio = await input.getPrimaryAudioTrack();
    // Codec strings as the decoders take them (avc1.42c01e), not mediabunny's names (avc).
    const vs = video === null ? undefined : await videoSetup(video);
    const as = audio === null ? undefined : await audioSetup(audio);
    info = {
      duration: Number.POSITIVE_INFINITY,
      startTime: 0,
      video: video === null || vs === undefined ? null : { id: video.id, codec: vs.codec, width: video.codedWidth, height: video.codedHeight, setup: vs },
      audio: audio === null || as === undefined ? null : { id: audio.id, codec: as.codec, sampleRate: audio.sampleRate, channels: audio.numberOfChannels, setup: as },
    };
  } catch (err) {
    input.dispose();
    throw isOtter(err) ? err : muxError('tsDemuxFailed', err);
  }
  // Media time 0: the first video keyframe (the first audio packet without video).
  let base: number | undefined;
  const pump = async (kind: 'video' | 'audio', track: InputVideoTrack | InputAudioTrack): Promise<void> => {
    const sink = new mb.EncodedPacketSink(track);
    for (let p = await sink.getFirstPacket(); p !== null && !options.signal.aborted; p = await sink.getNextPacket(p, { verifyKeyPackets: false })) {
      if (base === undefined) {
        if (kind === 'audio' && video !== null) continue;
        if (kind === 'video' && p.type !== 'key') continue;
        base = p.timestamp;
      }
      const timestamp = Math.round((p.timestamp - base) * 1e6);
      if (timestamp < 0) continue;
      fanout.push(kind, { key: p.type === 'key', timestamp, duration: Math.round(p.duration * 1e6), data: p.data });
    }
  };
  const done = Promise.all([video === null ? undefined : pump('video', video), audio === null ? undefined : pump('audio', audio)]);
  void done.then(
    () => fanout.end(),
    () => fanout.end(),
  );
  return {
    info,
    packets: (track) => fanout.packets(track, 0),
    seek: (track, time) => Promise.resolve(fanout.packets(track, time)),
    destroy() {
      fanout.end();
      input.dispose();
    },
  };
}

const isOtter = (e: unknown): e is Error => typeof e === 'object' && e !== null && 'details' in e && 'fatal' in e;
