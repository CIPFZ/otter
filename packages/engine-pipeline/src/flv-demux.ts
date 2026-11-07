// HTTP-FLV / WS-FLV as a WebCodecs Demuxer (ADR-013 §7, @otter-player/engine-pipeline/demux, an
// on-demand chunk): the pipeline's FLV sample reader (mpegts.js demuxer, L2) behind the media
// Demuxer interface, for the WebCodecs backend (surveillance walls). Live and endless: the duration
// is infinite, media time 0 is the first video keyframe, and every `seek()` / `packets()` is a new
// subscriber that starts at the most recent keyframe at or before the time asked for (audio: the
// frame covering it), out of the last HISTORY_S of packets. The fMP4 (MSE) pipeline is not touched.

import { createError as coreCreateError } from '@otter-player/core';
import { createLiveFanout, type DemuxAudioTrack, type DemuxInfo, type DemuxVideoTrack, type Demuxer } from '@otter-player/media';
import { createFlvSampleReader, type FlvAudioConfig, type FlvSamples, type FlvVideoConfig } from '@otter-player/pipeline/transmux';

/** What openFlvDemuxer takes. */
export interface FlvDemuxOptions {
  /** Aborts the request (a `flvAborted` error while opening). */
  readonly signal: AbortSignal;
  /** Core's createError, handed in (a value import shared with the caller). */
  readonly createError: typeof coreCreateError;
  /**
   * Request headers (HTTP-FLV).
   * @defaultValue none
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Give up (`flvOpenTimeout`) when the stream's configuration and first keyframe have not arrived
   * by then, ms.
   * @defaultValue `10000`
   */
  readonly openTimeoutMs?: number;
}

/** Packets kept for new subscribers (a seek, the audio started at the first gesture). */
/** Audio frames kept while waiting for the first keyframe (~10 s of AAC at 48 kHz). */
const EARLY_AUDIO_MAX = 500;
const HISTORY_S = 15;
/** After the video is ready, how long to wait for the audio configuration of a stream that declares audio. */
const AUDIO_WAIT_MS = 1500;

/** Bytes as they arrive: streaming fetch for http(s), binary messages for ws(s). `onOpen`: the connection answered. */
function openBytes(url: string, options: FlvDemuxOptions, onChunk: (b: Uint8Array) => void, onEnd: (err?: unknown) => void, onOpen: () => void): () => void {
  if (/^wss?:/i.test(url)) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = onOpen;
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data !== 'string') onChunk(new Uint8Array(e.data));
    };
    ws.onerror = () => onEnd(new Error(`WebSocket error on ${url}`));
    ws.onclose = () => onEnd();
    return () => ws.close();
  }
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  options.signal.addEventListener('abort', stop, { once: true });
  void (async () => {
    try {
      // no-store: Firefox holds a second request for the same cacheable URL until the first one is
      // complete, which an endless live stream never is (a wall with one URL twice; RESEARCH §1).
      const response = await fetch(url, { cache: 'no-store', ...(options.headers === undefined ? {} : { headers: options.headers }), signal: abort.signal });
      if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status} for ${url}`);
      onOpen();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk(value);
      }
      onEnd();
    } catch (err) {
      onEnd(err);
    }
  })();
  return stop;
}

/**
 * Opens an FLV stream (HTTP or WebSocket) as a demuxer for the WebCodecs backend: resolves once the
 * configuration and first keyframe arrived.
 */
export function openFlvDemuxer(url: string, options: FlvDemuxOptions): Promise<Demuxer> {
  const { createError } = options;
  const reader = createFlvSampleReader();
  const fanout = createLiveFanout(HISTORY_S);
  let videoConfig: FlvVideoConfig | undefined;
  let audioConfig: FlvAudioConfig | undefined;
  /** FLV ms of media time 0 (the first video keyframe; the first audio frame without video). */
  let base: number | undefined;
  /** Audio read before media time 0 is known. */
  const earlyAudio: FlvSamples['audio'][number][] = [];
  let videoSeen = false;
  /** The connection answered; the first bytes came (the startup breakdown). */
  const timing: { connectedAt?: number; firstBytesAt?: number } = {};

  const take = (samples: FlvSamples): void => {
    if (samples.videoConfig !== undefined) videoConfig ??= samples.videoConfig;
    if (samples.audioConfig !== undefined) audioConfig ??= samples.audioConfig;
    for (const v of samples.video) {
      if (base === undefined) {
        if (!v.key) continue;
        base = v.dts;
      }
      const timestamp = (v.pts - base) * 1000;
      if (timestamp < 0) continue;
      videoSeen = true;
      fanout.push('video', { key: v.key, timestamp, data: v.data });
    }
    const audioMs = audioConfig === undefined ? 0 : (1024 / audioConfig.sampleRate) * 1000;
    // Audio that came before the video's first keyframe waits for it (media time 0): what is at or
    // after the keyframe's time plays, the rest is dropped, whichever arrived first (as live TS,
    // ADR-013 §7). Without video, the first audio frame is media time 0.
    if (base === undefined && reader.declared?.video !== false) {
      earlyAudio.push(...samples.audio);
      if (earlyAudio.length > EARLY_AUDIO_MAX) earlyAudio.splice(0, earlyAudio.length - EARLY_AUDIO_MAX);
      return;
    }
    for (const a of [...earlyAudio.splice(0), ...samples.audio]) {
      base ??= a.pts;
      const timestamp = (a.pts - base) * 1000;
      if (timestamp < 0) continue;
      fanout.push('audio', { key: true, timestamp, duration: audioMs * 1000, data: a.data });
    }
  };

  return new Promise<Demuxer>((resolve, reject) => {
    let settled = false;
    let audioTimer: ReturnType<typeof setTimeout> | undefined;
    /** Declared audio that sent no configuration within AUDIO_WAIT_MS: played without. */
    let audioGivenUp = false;
    const fail = (err: unknown, details: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(audioTimer);
      stop();
      reject(createError({ type: 'network', details, fatal: true, recoverable: true, message: err instanceof Error ? err.message : String(err), cause: err }));
    };
    const timer = setTimeout(() => fail(new Error(`no FLV configuration and keyframe within ${options.openTimeoutMs ?? 10_000} ms`), 'flvOpenTimeout'), options.openTimeoutMs ?? 10_000);
    const ready = (): void => {
      if (settled) return;
      const declared = reader.declared;
      const videoReady = declared?.video === false || (videoConfig !== undefined && videoSeen);
      if (!videoReady) return;
      const audioWanted = declared?.audio === true && audioConfig === undefined && !audioGivenUp;
      if (audioWanted) {
        audioTimer ??= setTimeout(() => {
          audioGivenUp = true;
          ready();
        }, AUDIO_WAIT_MS);
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(audioTimer);
      const video: DemuxVideoTrack | null =
        videoConfig === undefined
          ? null
          : { id: 1, codec: videoConfig.codec, width: videoConfig.width, height: videoConfig.height, setup: { codec: videoConfig.codec, codedWidth: videoConfig.width, codedHeight: videoConfig.height, description: videoConfig.description.slice().buffer } };
      const audio: DemuxAudioTrack | null =
        audioConfig === undefined
          ? null
          : { id: 2, codec: audioConfig.codec, sampleRate: audioConfig.sampleRate, channels: audioConfig.channels, setup: { codec: audioConfig.codec, sampleRate: audioConfig.sampleRate, numberOfChannels: audioConfig.channels, description: audioConfig.description.slice().buffer } };
      const info: DemuxInfo = { duration: Number.POSITIVE_INFINITY, get startTime() { return fanout.startTime(video === null ? 'audio' : 'video'); }, video, audio };
      resolve({
        info,
        timing,
        packets: (track) => fanout.packets(track, 0),
        seek: (track, time) => Promise.resolve(fanout.packets(track, time)),
        destroy() {
          stop();
          fanout.end();
        },
      });
    };
    const stop = openBytes(
      url,
      options,
      (chunk) => {
        timing.firstBytesAt ??= performance.now();
        take(reader.push(chunk));
        const fatal = reader.errors.find((e) => e.fatal);
        if (fatal !== undefined) return fail(new Error(fatal.message), fatal.details);
        ready();
      },
      (err) => {
        fanout.end();
        if (err !== undefined && !options.signal.aborted) fail(err, 'flvRequestFailed');
        else if (!settled) fail(new Error('the FLV stream ended before it could play'), 'flvRequestFailed');
      },
      () => (timing.connectedAt ??= performance.now()),
    );
    options.signal.addEventListener('abort', () => fail(new Error('aborted'), 'flvAborted'), { once: true });
  });
}
