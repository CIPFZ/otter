// Shaka Player engine adapter (REUSE §3, L1; ADR-003 §3): DASH, and HLS with DRM (DRM only goes
// through Shaka, AGENT §6). Shaka owns the MediaSource; the adapter maps tracks, adaptation,
// stats and errors onto the Engine contract. Loaded with a dynamic import inside load().

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
import {
  resolveShakaNamespace,
  type ShakaError,
  type ShakaPlayer,
  type ShakaTextTrack,
  type ShakaTrack,
} from './shaka-types.js';
import type { AbrDriver } from '@otter-player/pipeline';
import { bufferedEndAt } from '@otter-player/media';
import type { OtterShakaAbr } from './abr.js';

export type { ShakaError, ShakaTrack } from './shaka-types.js';
export type { OtterShakaAbr, ShakaRestrictions, ShakaVariant } from './abr.js';

export interface ShakaEngineOptions {
  /** Format id reported by the engine (`dash` by default, `hls` when format-hls routes DRM here). */
  readonly formatId?: string;
  /** Extra Shaka configuration passed to `player.configure()` after the adapter defaults. */
  readonly config?: Record<string, unknown>;
  /** `otter` (default): the pipeline ABR rule stack decides via abrFactory; `engine`: Shaka's SimpleAbrManager (ADR-005 §1). */
  readonly abr?: 'otter' | 'engine';
}

/** Seconds buffered ahead of the playhead. */
const ahead = (m: HTMLMediaElement): number => Math.max(0, bufferedEndAt(m.buffered, m.currentTime) - m.currentTime);

/** shaka.util.Error.Category -> unified error type. */
const CATEGORIES: Readonly<Record<number, OtterErrorType>> = {
  1: 'network', // NETWORK
  2: 'other', // TEXT
  3: 'media', // MEDIA
  4: 'network', // MANIFEST
  5: 'media', // STREAMING
  6: 'drm', // DRM
  7: 'other', // PLAYER
};
const CRITICAL = 2; // shaka.util.Error.Severity.CRITICAL
const LICENSE_REQUEST = 2; // shaka.net.NetworkingEngine.RequestType.LICENSE

export function mapShakaError(error: ShakaError): OtterError {
  const type = CATEGORIES[error.category] ?? 'other';
  return createError({
    type,
    details: `shaka${error.code}`,
    fatal: error.severity === CRITICAL,
    recoverable: error.severity !== CRITICAL,
    message: error.message ?? `Shaka error ${error.code} (category ${error.category})`,
  });
}

const DYNAMIC_RANGE: Readonly<Record<string, NonNullable<VideoTrack['dynamicRange']>>> = { PQ: 'hdr10', HLG: 'hlg', SDR: 'sdr' };

export function mapShakaTracks(variants: readonly ShakaTrack[], textTracks: readonly ShakaTextTrack[], abr: boolean): TrackList {
  const active = variants.find((v) => v.active);
  // Qualities are the variants that share the active audio; one entry per video stream.
  const sameAudio = variants.filter((v) => active === undefined || v.audioId === active.audioId);
  const seenVideo = new Set<number | null>();
  const video: VideoTrack[] = [];
  for (const v of [...sameAudio].sort((a, b) => a.bandwidth - b.bandwidth)) {
    if (v.videoId === null || seenVideo.has(v.videoId)) continue;
    seenVideo.add(v.videoId);
    const range = v.hdr === null ? undefined : DYNAMIC_RANGE[v.hdr];
    video.push({
      kind: 'video',
      id: `variant-${v.id}`,
      selected: v.active,
      bitrate: v.bandwidth,
      ...(v.width === null ? {} : { width: v.width }),
      ...(v.height === null ? {} : { height: v.height }),
      ...(v.frameRate === null ? {} : { frameRate: v.frameRate }),
      ...(v.videoCodec === null ? {} : { codec: v.videoCodec }),
      ...(range === undefined ? {} : { dynamicRange: range }),
    });
  }
  const seenAudio = new Set<string>();
  const audio: AudioTrack[] = [];
  for (const v of variants) {
    if (v.audioId === null) continue;
    const id = `audio-${v.audioId}`;
    if (seenAudio.has(id)) continue;
    seenAudio.add(id);
    audio.push({
      kind: 'audio',
      id,
      selected: active?.audioId === v.audioId,
      ...(v.language === '' ? {} : { language: v.language }),
      ...(v.label === null ? {} : { label: v.label }),
      ...(v.audioCodec === null ? {} : { codec: v.audioCodec }),
      ...(v.channelsCount === null ? {} : { channels: v.channelsCount }),
      ...(v.audioBandwidth === null ? {} : { bitrate: v.audioBandwidth }),
    });
  }
  const text: TextTrackInfo[] = textTracks.map((t) => ({
    kind: 'text',
    id: `text-${t.id}`,
    role: t.kind === 'caption' ? 'captions' : 'subtitles',
    selected: t.active,
    ...(t.language === '' ? {} : { language: t.language }),
    ...(t.label === null ? {} : { label: t.label }),
    ...(t.mimeType?.includes('ttml') === true ? { format: 'ttml' as const } : t.mimeType?.includes('vtt') === true ? { format: 'vtt' as const } : {}),
  }));
  const selected = video.find((v) => v.selected);
  return {
    video,
    audio,
    text,
    quality: video.length > 1 ? 'selectable' : 'opaque',
    requestedQuality: abr || selected === undefined ? 'auto' : selected.id,
  };
}

export function createShakaEngine(ctx: EngineContext, options: ShakaEngineOptions = {}): Engine {
  const bus = createEventBus<EngineEvents>();
  let player: ShakaPlayer | undefined;
  let tracks: TrackList = EMPTY_TRACKS;
  let abr = true;
  let destroyed = false;
  // Selected in-band text track; the session re-applies it after every (re)load.
  let selectedText: string | null = null;
  let firstSegment = false;
  // Created in load(): the rule stack is imported next to Shaka so it stays out of the first screen.
  let driver: AbrDriver | undefined;
  let manager: OtterShakaAbr | undefined;
  const abrReason = (id: string): string => {
    if (manager === undefined) return 'abr (shaka)';
    const last = manager.lastChoice;
    return last !== undefined && last.id === id ? `abr: ${last.reason}` : 'abr';
  };

  const refresh = (): void => {
    if (player === undefined) return;
    tracks = mapShakaTracks(player.getVariantTracks(), player.getTextTracks(), abr);
    bus.emit('tracks-change', tracks);
  };
  const activeQualityId = (): string | undefined => tracks.video.find((v) => v.selected)?.id;
  /**
   * Live latency in seconds: Shaka's wall-clock getLiveLatency() (needs a presentation start
   * time), else stats.liveLatency, else the distance to the seek range end.
   */
  const liveLatency = (): number | undefined => {
    if (player?.isLive() !== true) return undefined;
    const wallClock = player.getLiveLatency?.();
    if (wallClock !== undefined && wallClock !== null && Number.isFinite(wallClock) && wallClock >= 0) return wallClock / 1000;
    const reported = player.getStats().liveLatency;
    if (Number.isFinite(reported) && reported > 0) return reported;
    const edge = player.seekRange().end - ctx.media.currentTime;
    return Number.isFinite(edge) && edge >= 0 ? edge : undefined;
  };
  const reportStats = (): void => {
    if (player === undefined) return;
    const stats = player.getStats();
    if (driver !== undefined && driver.canEstimate) {
      bus.emit('bandwidth', driver.bandwidth);
    } else if (Number.isFinite(stats.estimatedBandwidth) && stats.estimatedBandwidth > 0) {
      const estimate = stats.estimatedBandwidth;
      bus.emit('bandwidth', { estimate, fast: estimate, slow: estimate });
    }
    const latency = liveLatency();
    if (latency !== undefined) bus.emit('latency-change', { latency });
  };

  return {
    formatId: options.formatId ?? 'dash',
    get tracks() {
      return tracks;
    },
    get latency() {
      return liveLatency();
    },
    get mms() {
      // Shaka's MediaSourceEngine uses ManagedMediaSource whenever the browser has it.
      return player !== undefined && (globalThis as { ManagedMediaSource?: unknown }).ManagedMediaSource !== undefined;
    },
    async load() {
      const src = ctx.source.src;
      if (typeof src !== 'string') {
        throw createError({ type: 'other', details: 'unsupportedSource', fatal: true, recoverable: false, message: 'Shaka needs a URL' });
      }
      // ABR rule stack and CMCD glue load together with Shaka (ADR-004 §2).
      const [shakaModule, pipeline, abrGlue, cmcdGlue, textGlue] = await Promise.all([
        import('shaka-player'),
        options.abr === 'engine' ? undefined : import('@otter-player/pipeline'),
        options.abr === 'engine' ? undefined : import('./abr.js'),
        ctx.cmcd === undefined ? undefined : import('./cmcd.js'),
        import('./text.js'),
      ]);
      const shaka = resolveShakaNamespace(shakaModule);
      driver = pipeline?.createAbrDriver();
      manager = driver === undefined || abrGlue === undefined ? undefined : abrGlue.createOtterShakaAbr(driver, { bufferAhead: ahead });
      if (destroyed) return;
      if (shaka === undefined) {
        throw createError({ type: 'other', details: 'engineLoadFailed', fatal: true, recoverable: false, message: 'shaka-player did not expose a Player' });
      }
      shaka.polyfill.installAll();
      if (!shaka.Player.isBrowserSupported()) {
        throw createError({ type: 'media', details: 'engineUnsupported', fatal: true, recoverable: false, message: 'Shaka Player is not supported here' });
      }
      const p = new shaka.Player();
      player = p;
      let loading = true;
      p.addEventListener('error', (event) => {
        const error = mapShakaError(event.detail as ShakaError);
        // While load() is pending, its rejection carries the error; do not report it twice.
        if (!(loading && error.fatal)) bus.emit('error', error);
      });
      p.addEventListener('trackschanged', refresh);
      p.addEventListener('adaptation', () => {
        refresh();
        const id = activeQualityId();
        if (id !== undefined) bus.emit('quality-change', { id, auto: true, reason: abrReason(id) });
      });
      p.addEventListener('variantchanged', () => {
        refresh();
        const id = activeQualityId();
        if (id !== undefined) bus.emit('quality-change', { id, auto: abr, reason: abr ? 'abr' : 'manual' });
      });
      p.addEventListener('segmentappended', () => {
        if (!firstSegment) {
          firstSegment = true;
          bus.emit('first-segment', { at: performance.now() });
        }
        reportStats();
      });

      const drm = ctx.source.drm;
      // Shaka 5 defaults streaming.lowLatencyMode to true and applies it only to low-latency manifests.
      p.configure({
        abr: { enabled: true },
        ...(manager === undefined ? {} : { abrFactory: () => manager }),
        // Cues go to the text package instead of Shaka's own DOM / native displayer.
        textDisplayFactory: () =>
          textGlue.createTextDisplayer(
            () => (selectedText !== null && player?.getTextTracks().some((t) => t.active && `text-${t.id}` === selectedText) === true ? selectedText : null),
            (cues) => bus.emit('text-cues', cues),
          ),
        ...(drm === undefined ? {} : { drm: { servers: { ...drm.servers }, clearKeys: { ...drm.clearKeys } } }),
      });
      if (options.config !== undefined) p.configure(options.config);
      const headers = ctx.source.headers;
      const licenseHeaders = drm?.headers;
      const cmcd = ctx.cmcd;
      if (headers !== undefined || licenseHeaders !== undefined || cmcd !== undefined) {
        p.getNetworkingEngine()?.registerRequestFilter((type, request, context) => {
          Object.assign(request.headers, headers, type === LICENSE_REQUEST ? licenseHeaders : undefined);
          if (cmcd === undefined) return;
          // Shaka retries across request.uris; decorate each one the same way.
          request.uris = request.uris.map((uri) => {
            const info = cmcdGlue?.shakaCmcdRequest(type, uri, context);
            if (info === undefined) return uri;
            const d = cmcd.decorate(info);
            Object.assign(request.headers, d.headers);
            return d.url;
          });
        });
      }

      await p.attach(ctx.media);
      try {
        await p.load(src, ctx.options.startTime ?? null, ctx.source.type ?? null);
      } catch (err) {
        throw typeof err === 'object' && err !== null && 'category' in err ? mapShakaError(err as ShakaError) : err;
      } finally {
        loading = false;
      }
      refresh();
      reportStats();
    },
    selectAudioTrack(id) {
      if (player === undefined) return;
      const variant = player.getVariantTracks().find((v) => v.audioId !== null && `audio-${v.audioId}` === id);
      const tracks = player.getAudioTracks?.() ?? [];
      if (variant === undefined || tracks.length === 0) return;
      // Shaka's audio tracks are not keyed by stream id in every build; match what identifies them.
      const track =
        tracks.find((t) => t.id === variant.audioId) ??
        tracks.find((t) => t.language === variant.language && (t.label ?? null) === (variant.label ?? null) && (t.channelsCount ?? null) === (variant.channelsCount ?? null));
      if (track !== undefined) player.selectAudioTrack?.(track);
      refresh();
    },
    selectTextTrack(id) {
      selectedText = id;
      if (player === undefined) return;
      const track = id === null ? undefined : player.getTextTracks().find((t) => `text-${t.id}` === id);
      if (track !== undefined) player.selectTextTrack(track);
      player.setTextTrackVisibility(track !== undefined);
      refresh();
    },
    selectQuality(id) {
      if (player === undefined) return;
      if (id === 'auto') {
        abr = true;
        player.configure({ abr: { enabled: true } });
        refresh();
        return;
      }
      const variant = player.getVariantTracks().find((v) => `variant-${v.id}` === id);
      if (variant === undefined) return;
      abr = false;
      player.configure({ abr: { enabled: false } });
      player.selectVariantTrack(variant, true);
    },
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      destroyed = true;
      bus.clear();
      void player?.destroy();
      player = undefined;
    },
  };
}
