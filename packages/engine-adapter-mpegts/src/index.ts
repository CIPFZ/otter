// mpegts.js engine adapter (REUSE §3, L1 now, L2 demuxers later; ADR-003 §3): HTTP-FLV / WS-FLV /
// MPEG-TS. mpegts.js owns the MediaSource (ManagedMediaSource only when MediaSource is missing).
// Its CommonJS typings are described structurally, like the Shaka adapter.

import { createError, createEventBus, type OtterError, type OtterErrorType } from '@otter-player/core';
import { EMPTY_TRACKS, type Engine, type EngineContext, type EngineEvents, type TrackList } from '@otter-player/media';

export type MpegtsType = 'flv' | 'mpegts';

export interface MpegtsEngineOptions {
  /** Container type; format-flv passes `flv`, format-ts passes `mpegts`. */
  readonly type: MpegtsType;
  /** Extra mpegts.js player config applied over the adapter defaults. */
  readonly config?: Record<string, unknown>;
}

interface MpegtsMediaInfo {
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly videoDataRate?: number;
  readonly audioDataRate?: number;
}

interface MpegtsStatistics {
  /** KB/s */
  readonly speed?: number;
  readonly droppedFrames?: number;
  readonly decodedFrames?: number;
}

interface MpegtsPlayer {
  on(event: string, listener: (...args: unknown[]) => void): void;
  attachMediaElement(media: HTMLMediaElement): void;
  detachMediaElement(): void;
  load(): void;
  unload(): void;
  destroy(): void;
}

interface MpegtsNamespace {
  isSupported(): boolean;
  createPlayer(source: Record<string, unknown>, config?: Record<string, unknown>): MpegtsPlayer;
  readonly Events: { readonly ERROR: string; readonly MEDIA_INFO: string; readonly STATISTICS_INFO: string };
}

function resolveMpegts(mod: unknown): MpegtsNamespace | undefined {
  let current: unknown = mod;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
    if ('createPlayer' in current && 'Events' in current) return current as MpegtsNamespace;
    current = (current as { default?: unknown }).default;
  }
  return undefined;
}

/** mpegts.js ErrorTypes: NetworkError / MediaError / OtherError. Its errors stop playback. */
const ERROR_TYPES: Readonly<Record<string, OtterErrorType>> = {
  NetworkError: 'network',
  MediaError: 'media',
  OtherError: 'other',
};

export function mapMpegtsError(type: unknown, details: unknown, info: unknown): OtterError {
  const message = typeof info === 'object' && info !== null && 'msg' in info ? String((info as { msg: unknown }).msg) : String(details);
  return createError({
    type: ERROR_TYPES[String(type)] ?? 'other',
    details: typeof details === 'string' && details !== '' ? details : 'mpegtsError',
    fatal: true,
    recoverable: String(type) === 'NetworkError',
    message,
  });
}

export function mapMpegtsTracks(info: MpegtsMediaInfo): TrackList {
  const bitrate = ((info.videoDataRate ?? 0) + (info.audioDataRate ?? 0)) * 1000;
  return {
    ...EMPTY_TRACKS,
    video: [
      {
        kind: 'video',
        id: 'main',
        selected: true,
        ...(info.width === undefined ? {} : { width: info.width }),
        ...(info.height === undefined ? {} : { height: info.height }),
        ...(info.fps === undefined ? {} : { frameRate: info.fps }),
        ...(info.videoCodec === undefined ? {} : { codec: info.videoCodec }),
        ...(bitrate > 0 ? { bitrate } : {}),
      },
    ],
    audio:
      info.audioCodec === undefined ? [] : [{ kind: 'audio', id: 'main', selected: true, codec: info.audioCodec }],
    quality: 'opaque',
  };
}

export function createMpegtsEngine(ctx: EngineContext, options: MpegtsEngineOptions): Engine {
  const bus = createEventBus<EngineEvents>();
  let player: MpegtsPlayer | undefined;
  let tracks: TrackList = EMPTY_TRACKS;
  let destroyed = false;
  let firstSegment = false;
  // Treating a VOD file as live would make latency chasing skip ahead; live must be explicit.
  const live = ctx.source.live ?? false;

  const liveLatency = (): number | undefined => {
    const m = ctx.media;
    if (!live || m.buffered.length === 0) return undefined;
    return Math.max(0, m.buffered.end(m.buffered.length - 1) - m.currentTime);
  };

  return {
    formatId: options.type === 'flv' ? 'flv' : 'ts',
    get tracks() {
      return tracks;
    },
    get latency() {
      return liveLatency();
    },
    get mms() {
      const g = globalThis as { ManagedMediaSource?: unknown; MediaSource?: unknown };
      return player !== undefined && g.MediaSource === undefined && g.ManagedMediaSource !== undefined;
    },
    async load() {
      const url = ctx.source.src;
      if (typeof url !== 'string') {
        throw createError({ type: 'other', details: 'unsupportedSource', fatal: true, recoverable: false, message: 'mpegts.js needs a URL' });
      }
      const mpegts = resolveMpegts(await import('mpegts.js'));
      if (destroyed) return;
      if (mpegts === undefined) {
        throw createError({ type: 'other', details: 'engineLoadFailed', fatal: true, recoverable: false, message: 'mpegts.js did not expose createPlayer' });
      }
      if (!mpegts.isSupported()) {
        throw createError({ type: 'media', details: 'engineUnsupported', fatal: true, recoverable: false, message: 'mpegts.js is not supported here' });
      }
      const p = mpegts.createPlayer(
        { type: options.type, isLive: live, url },
        {
          enableWorker: false,
          lazyLoad: !live,
          // Live latency control (SPEC §7 LiveController behaviour, provided by mpegts.js in M1).
          liveBufferLatencyChasing: live,
          liveSync: live,
          ...(ctx.source.headers === undefined ? {} : { headers: { ...ctx.source.headers } }),
          ...options.config,
        },
      );
      player = p;
      const { Events } = mpegts;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        p.on(Events.MEDIA_INFO, (info) => {
          tracks = mapMpegtsTracks(info as MpegtsMediaInfo);
          bus.emit('tracks-change', tracks);
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        p.on(Events.ERROR, (type, details, info) => {
          const error = mapMpegtsError(type, details, info);
          if (!settled) {
            settled = true;
            reject(error);
            return;
          }
          bus.emit('error', error);
        });
        p.on(Events.STATISTICS_INFO, (stats) => {
          const s = stats as MpegtsStatistics;
          if (!firstSegment && (s.decodedFrames ?? 0) > 0) {
            firstSegment = true;
            bus.emit('first-segment', { at: performance.now() });
          }
          if (s.speed !== undefined && s.speed > 0) {
            const estimate = s.speed * 8 * 1024;
            bus.emit('bandwidth', { estimate, fast: estimate, slow: estimate });
          }
          const latency = liveLatency();
          if (latency !== undefined) bus.emit('latency-change', { latency });
        });
        p.attachMediaElement(ctx.media);
        p.load();
      });
    },
    // Single rendition: nothing to select.
    selectQuality: () => undefined,
    on: (e, h) => bus.on(e, (payload) => h(payload)),
    destroy() {
      destroyed = true;
      bus.clear();
      if (player !== undefined) {
        player.unload();
        player.detachMediaElement();
        player.destroy();
      }
      player = undefined;
    },
  };
}
