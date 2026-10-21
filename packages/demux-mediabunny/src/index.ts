// mediabunny (L1) as the WebCodecs backend's Demuxer (ADR-008 §2): a local File / Blob
// (format-file: MP4 / MOV / WebM / MKV / MPEG-TS / Ogg ...) or an HLS playlist URL (format-hls,
// when MSE cannot play the codec, e.g. HEVC). Formats load this package on demand. Container
// timestamps are media time as they are (like <video>); packets go out with a copied, transferable
// ArrayBuffer. createError comes from the caller: a value import shared by a format's entry and
// this lazily loaded package would make the entry's module graph side-effectful
// (scripts/check-side-effects.ts).

import type { createError as CreateError } from '@otter-player/core';
import type { DecodeSetup, Demuxer, DemuxInfo, EncodedChunk, PacketStream } from '@otter-player/media';
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

/** Packets from `start` in decode order; stops when `signal` aborts. */
async function* stream(sink: EncodedPacketSink, start: EncodedPacket | null, signal: AbortSignal): AsyncGenerator<EncodedChunk> {
  if (start === null) return;
  for await (const p of sink.packets(start, undefined, { verifyKeyPackets: false })) {
    if (signal.aborted) return;
    yield toChunk(p);
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
 * An HLS playlist (multivariant or media). The primary video rendition (highest bitrate) and the
 * audio paired with it are played; there is no ABR on this path yet.
 */
export async function openHls(url: string, options: OpenOptions): Promise<Demuxer> {
  const mb = await lib();
  const input = new mb.Input({
    source: new mb.UrlSource(url, options.headers === undefined ? {} : { requestInit: { headers: { ...options.headers } } }),
    formats: mb.HLS_FORMATS,
    // Media time from the playlist, not wall-clock (EXT-X-PROGRAM-DATE-TIME).
    formatOptions: { hls: { offsetTimestampsByDateTime: false } },
  });
  return open(mb, input, options);
}

async function open(mb: typeof import('mediabunny'), input: Input, options: OpenOptions): Promise<Demuxer> {
  createError = options.createError;
  const signal = options.signal;
  try {
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    if (video === null && audio === null) throw muxError('noTracks', 'no audio or video track');
    const used = [video, audio].filter((t) => t !== null);
    const [startTime, end] = await Promise.all([input.getFirstTimestamp(used), input.computeDuration(used)]);
    const vSetup = video === null ? null : await videoSetup(video);
    const aSetup = audio === null ? null : await audioSetup(audio);
    const stats = video === null ? null : await video.computePacketStats(120).catch(() => null);
    const info: DemuxInfo = {
      duration: end,
      startTime,
      video:
        video === null || vSetup === null
          ? null
          : {
              id: video.id,
              codec: vSetup.codec,
              setup: vSetup,
              width: await video.getSquarePixelWidth(),
              height: await video.getSquarePixelHeight(),
              ...(stats === null || !(stats.averagePacketRate > 0) ? {} : { frameRate: stats.averagePacketRate }),
            },
      audio:
        audio === null || aSetup === null
          ? null
          : { id: audio.id, codec: aSetup.codec, setup: aSetup, sampleRate: await audio.getSampleRate(), channels: await audio.getNumberOfChannels() },
    };
    const sinks = {
      video: video === null ? null : new mb.EncodedPacketSink(video),
      audio: audio === null ? null : new mb.EncodedPacketSink(audio),
    };
    const sinkOf = (track: 'video' | 'audio'): EncodedPacketSink => {
      const s = sinks[track];
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
      destroy() {
        input.dispose();
      },
    };
  } catch (err) {
    input.dispose();
    if ((err as { details?: unknown } | null)?.details !== undefined) throw err;
    throw muxError('demuxFailed', err);
  }
}
