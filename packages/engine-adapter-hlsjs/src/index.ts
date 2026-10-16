// hls.js engine adapter (REUSE §3, L1; ADR-003 §3). hls.js owns the MediaSource on the element;
// the adapter only maps its events, levels and errors onto the Otter Engine contract. hls.js is
// loaded with a dynamic import inside load(), so it stays out of the first-screen bundle.

import { createError, createEventBus, type OtterError, type OtterErrorType } from '@otter-player/core';
import {
  EMPTY_TRACKS,
  type AudioTrack,
  type Engine,
  type EngineContext,
  type EngineEvents,
  type TextTrackInfo,
  type TrackList,
  type VideoTrack,
} from '@otter-player/media';
import { createAbrDriver, type AbrDriver } from '@otter-player/pipeline';
import type Hls from 'hls.js';
import type { ErrorData, HlsConfig, Level, MediaPlaylist } from 'hls.js';
import { createOtterAbrController, levelsOf } from './abr.js';

export { bufferAhead } from './abr.js';

export interface HlsJsEngineOptions {
  /** Extra hls.js configuration, applied over the adapter defaults. */
  readonly config?: Partial<HlsConfig>;
  /** Use the `hls.js/light` build (no subtitles, alt audio or EME). */
  readonly light?: boolean;
  /** `otter` (default): the pipeline ABR rule stack decides; `engine`: hls.js' own ABR (ADR-005 §1). */
  readonly abr?: 'otter' | 'engine';
}

const ERROR_TYPES: Readonly<Record<string, OtterErrorType>> = {
  networkError: 'network',
  mediaError: 'media',
  keySystemError: 'drm',
  muxError: 'mux',
  otherError: 'other',
};

/** A fatal media error is retried once through recoverMediaError within this window. */
const MEDIA_RECOVERY_WINDOW_MS = 3000;

/**
 * Media errors that recoverMediaError cannot fix: retrying would keep load() pending forever.
 * manifestIncompatibleCodecsError is typed mediaError by hls.js (e.g. HEVC without decoder).
 */
const UNRECOVERABLE_MEDIA_ERRORS: ReadonlySet<string> = new Set(['manifestIncompatibleCodecsError']);

export function mapHlsError(data: Pick<ErrorData, 'type' | 'details' | 'fatal' | 'error'>, fatal: boolean = data.fatal): OtterError {
  const type = ERROR_TYPES[data.type] ?? 'other';
  return createError({
    type,
    details: data.details,
    fatal,
    recoverable: type === 'network' || type === 'media',
    message: data.error?.message ?? data.details,
    cause: data.error,
  });
}

const levelId = (index: number): string => `level-${index}`;

export function mapHlsTracks(hls: Pick<Hls, 'levels' | 'currentLevel' | 'audioTracks' | 'audioTrack' | 'subtitleTracks' | 'subtitleTrack' | 'autoLevelEnabled'>): TrackList {
  const video: VideoTrack[] = hls.levels.map((l: Level, i: number) => ({
    kind: 'video',
    id: levelId(i),
    selected: i === hls.currentLevel,
    bitrate: l.bitrate,
    ...(l.width > 0 ? { width: l.width } : {}),
    ...(l.height > 0 ? { height: l.height } : {}),
    ...(l.frameRate > 0 ? { frameRate: l.frameRate } : {}),
    ...(l.videoCodec === undefined ? {} : { codec: l.videoCodec }),
    ...(l.name === '' ? {} : { label: l.name }),
  }));
  const playlist = <T extends AudioTrack | TextTrackInfo>(t: MediaPlaylist, base: T): T => ({
    ...base,
    ...(t.name === '' ? {} : { label: t.name }),
    ...(t.lang === undefined ? {} : { language: t.lang }),
  });
  const audio: AudioTrack[] = hls.audioTracks.map((t) =>
    playlist<AudioTrack>(t, { kind: 'audio', id: `audio-${t.id}`, selected: t.id === hls.audioTrack }),
  );
  const text: TextTrackInfo[] = hls.subtitleTracks.map((t) =>
    playlist<TextTrackInfo>(t, {
      kind: 'text',
      id: `text-${t.id}`,
      role: t.type === 'CLOSED-CAPTIONS' ? 'captions' : 'subtitles',
      format: 'vtt',
      selected: t.id === hls.subtitleTrack,
    }),
  );
  return {
    video,
    audio,
    text,
    quality: video.length > 1 ? 'selectable' : 'opaque',
    requestedQuality: hls.autoLevelEnabled ? 'auto' : levelId(hls.currentLevel),
  };
}

/** Mirrors hls.js getMediaSource(): MMS when preferred and present, or when it is the only option. */
const usesMms = (prefer: boolean): boolean => {
  const g = globalThis as { ManagedMediaSource?: unknown; MediaSource?: unknown };
  return g.ManagedMediaSource !== undefined && (prefer || g.MediaSource === undefined);
};

export function createHlsJsEngine(ctx: EngineContext, options: HlsJsEngineOptions = {}): Engine {
  const bus = createEventBus<EngineEvents>();
  let hls: Hls | undefined;
  let tracks: TrackList = EMPTY_TRACKS;
  let destroyed = false;
  let firstSegment = false;
  let lastMediaRecovery = Number.NEGATIVE_INFINITY;
  const driver: AbrDriver | undefined = options.abr === 'engine' ? undefined : createAbrDriver();
  const onSeeking = (): void => driver?.reset();

  const refresh = (): void => {
    if (hls === undefined) return;
    tracks = mapHlsTracks(hls);
    bus.emit('tracks-change', tracks);
  };

  return {
    formatId: 'hls',
    get tracks() {
      return tracks;
    },
    get latency() {
      // hls.js also reports a "latency" for VOD; only live playlists have a live edge.
      return hls?.latestLevelDetails?.live === true && hls.latency > 0 ? hls.latency : undefined;
    },
    get mms() {
      return hls !== undefined && usesMms(ctx.mms);
    },
    async load() {
      const src = ctx.source.src;
      if (typeof src !== 'string') {
        throw createError({ type: 'other', details: 'unsupportedSource', fatal: true, recoverable: false, message: 'hls.js needs a URL' });
      }
      const mod = options.light === true ? await import('hls.js/light') : await import('hls.js');
      const HlsCtor = mod.default;
      if (destroyed) return;
      if (!HlsCtor.isSupported()) {
        throw createError({ type: 'media', details: 'engineUnsupported', fatal: true, recoverable: false, message: 'hls.js is not supported here' });
      }
      const headers = ctx.source.headers;
      // Builds without an exported AbrController fall back to hls.js' own ABR.
      const Base = (mod as { AbrController?: Parameters<typeof createOtterAbrController>[0] }).AbrController;
      const abrController = driver === undefined || Base === undefined ? undefined : createOtterAbrController(Base, driver, ctx.media);
      const instance = new HlsCtor({
        ...(abrController === undefined ? {} : { abrController }),
        preferManagedMediaSource: ctx.mms,
        startPosition: ctx.options.startTime ?? -1,
        ...(headers === undefined
          ? {}
          : {
              xhrSetup: (xhr: XMLHttpRequest) => {
                for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
              },
            }),
        ...options.config,
      });
      hls = instance;
      const { Events } = HlsCtor;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        instance.on(Events.MANIFEST_PARSED, () => {
          refresh();
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        instance.on(Events.ERROR, (_e, data) => {
          const recoverable =
            settled &&
            data.fatal &&
            data.type === 'mediaError' &&
            !UNRECOVERABLE_MEDIA_ERRORS.has(data.details) &&
            performance.now() - lastMediaRecovery > MEDIA_RECOVERY_WINDOW_MS;
          if (recoverable) {
            // hls.js' documented recovery path: one recoverMediaError() before giving up.
            lastMediaRecovery = performance.now();
            instance.recoverMediaError();
            bus.emit('error', mapHlsError(data, false));
            return;
          }
          const error = mapHlsError(data);
          if (!settled && error.fatal) {
            settled = true;
            reject(error);
            return;
          }
          bus.emit('error', error);
        });
        instance.loadSource(src);
        instance.attachMedia(ctx.media);
      });

      instance.on(Events.LEVEL_SWITCHED, (_e, { level }) => {
        refresh();
        driver?.applied(level, levelsOf(instance));
        const auto = instance.autoLevelEnabled;
        const decided = driver?.lastDecision;
        const reason = !auto
          ? 'manual'
          : driver === undefined
            ? 'abr (hls.js)'
            : decided !== undefined && decided.engineLevel === level
              ? `abr: ${decided.reason}`
              : 'abr (hls.js startup / emergency)';
        bus.emit('quality-change', { id: levelId(level), auto, reason });
      });
      ctx.media.addEventListener('seeking', onSeeking);
      instance.on(Events.AUDIO_TRACKS_UPDATED, refresh);
      instance.on(Events.SUBTITLE_TRACKS_UPDATED, refresh);
      instance.on(Events.FRAG_LOADED, (_e, { frag, part }) => {
        const stats = (part ?? frag).stats as typeof frag.stats | undefined;
        if (driver !== undefined && frag.type === 'main' && stats !== undefined && !stats.aborted && stats.loaded > 0) {
          driver.sampleDownload(stats.loading.end - stats.loading.first, stats.loaded, stats.loading.first - stats.loading.start);
        }
        if (!firstSegment && frag.type === 'main') {
          firstSegment = true;
          bus.emit('first-segment', { at: performance.now() });
        }
      });
      let mappedLevel = instance.currentLevel;
      instance.on(Events.FRAG_BUFFERED, (_e, { frag }) => {
        if (frag.type !== 'main') return;
        // LEVEL_SWITCHED depends on the playing fragment changing level, which LL-HLS parts do
        // not always trigger; keep the selected flag current from the buffered level instead.
        if (instance.currentLevel !== mappedLevel) {
          mappedLevel = instance.currentLevel;
          refresh();
        }
        driver?.segmentAppended();
        if (driver !== undefined && driver.canEstimate) {
          bus.emit('bandwidth', driver.bandwidth);
        } else {
          const estimate = instance.bandwidthEstimate;
          if (Number.isFinite(estimate) && estimate > 0) bus.emit('bandwidth', { estimate, fast: estimate, slow: estimate });
        }
        const latency = instance.latency;
        if (instance.latestLevelDetails?.live === true && latency > 0) {
          const target = instance.targetLatency;
          bus.emit('latency-change', target === null ? { latency } : { latency, target });
        }
      });
    },
    selectQuality(id) {
      if (hls === undefined) return;
      if (id === 'auto') {
        // Back to ABR from the next fragment, without flushing.
        hls.nextLevel = -1;
        return;
      }
      const index = Number(id.replace(/^level-/, ''));
      // A manual choice applies now (flushes the buffer), like Shaka's selectVariantTrack(t, true):
      // nextLevel would wait for the next fragment, which never comes once the buffer is full.
      if (Number.isInteger(index) && index >= 0 && index < hls.levels.length) hls.currentLevel = index;
    },
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      destroyed = true;
      bus.clear();
      ctx.media.removeEventListener('seeking', onSeeking);
      hls?.destroy();
      hls = undefined;
    },
  };
}
