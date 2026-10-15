// Capability detection (SPEC §5.1): probed once, cached, and fed to FormatPlugin.probe and the router.
// Feature presence is checked without creating contexts (WebGL / WebGPU are capped per page), so
// `webgl2` / `webgpu` mean "API present".

import { createError } from '@otter-player/core';

export interface CodecDecodingInfo {
  readonly supported: boolean;
  readonly smooth: boolean;
  readonly powerEfficient: boolean;
}

export interface Capabilities {
  readonly mediaSource: boolean;
  readonly managedMediaSource: boolean;
  /** `MediaSourceHandle` (MSE in Worker), Chrome 108+. */
  readonly mseInWorker: boolean;
  readonly webCodecs: boolean;
  /** `canPlayType('application/vnd.apple.mpegurl')` */
  readonly nativeHls: boolean;
  /** `MediaCapabilities.decodingInfo` results keyed by full MIME + codecs string. */
  readonly codecs: Readonly<Record<string, CodecDecodingInfo>>;
  /** `requestMediaKeySystemAccess` result per key system. */
  readonly keySystems: Readonly<Record<string, boolean>>;
  readonly pictureInPicture: boolean;
  readonly documentPictureInPicture: boolean;
  readonly orientationLock: boolean;
  readonly wakeLock: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly crossOriginIsolated: boolean;
  readonly offscreenCanvas: boolean;
  readonly webgl2: boolean;
  readonly webgpu: boolean;
  /** `(pointer: coarse)` */
  readonly coarsePointer: boolean;
  readonly dynamicRange: 'standard' | 'high';
  readonly colorGamut: 'srgb' | 'p3' | 'rec2020';
}

export interface CapabilityProbeOptions {
  /** MIME + codecs strings to run through `decodingInfo`; defaults to DEFAULT_PROBE_CODECS. */
  readonly codecs?: readonly string[];
  /** Key systems to query; none by default (EME queries can be slow or prompt on some browsers). */
  readonly keySystems?: readonly string[];
  /** Drop cached results and probe again. */
  readonly refresh?: boolean;
}

/** Baseline with nothing supported: SSR, tests, and the starting point of detection. */
export const NO_CAPABILITIES: Capabilities = {
  mediaSource: false,
  managedMediaSource: false,
  mseInWorker: false,
  webCodecs: false,
  nativeHls: false,
  codecs: {},
  keySystems: {},
  pictureInPicture: false,
  documentPictureInPicture: false,
  orientationLock: false,
  wakeLock: false,
  sharedArrayBuffer: false,
  crossOriginIsolated: false,
  offscreenCanvas: false,
  webgl2: false,
  webgpu: false,
  coarsePointer: false,
  dynamicRange: 'standard',
  colorGamut: 'srgb',
};

/** Codecs probed when the caller does not ask for specific ones (RESEARCH §2.2). */
export const DEFAULT_PROBE_CODECS: readonly string[] = [
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="avc1.640028"',
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="av01.0.05M.08"',
  'video/webm; codecs="vp09.00.10.08"',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="opus"',
];

const KEY_SYSTEM_TIMEOUT_MS = 3000;

type MediaSourceCtor = { isTypeSupported(type: string): boolean; canConstructInDedicatedWorker?: boolean };

interface MediaGlobals {
  MediaSource?: MediaSourceCtor;
  ManagedMediaSource?: MediaSourceCtor;
  VideoDecoder?: unknown;
  SharedArrayBuffer?: unknown;
  OffscreenCanvas?: unknown;
  WebGL2RenderingContext?: unknown;
  crossOriginIsolated?: boolean;
  documentPictureInPicture?: unknown;
  matchMedia?: (query: string) => { matches: boolean };
  document?: Document;
  screen?: { orientation?: { lock?: unknown } };
  navigator?: {
    wakeLock?: { request?: unknown };
    gpu?: { requestAdapter?: unknown };
    mediaCapabilities?: { decodingInfo?: (config: MediaDecodingConfiguration) => Promise<MediaCapabilitiesInfo> };
    requestMediaKeySystemAccess?: (ks: string, configs: MediaKeySystemConfiguration[]) => Promise<unknown>;
  };
}

const env = (): MediaGlobals => globalThis as unknown as MediaGlobals;

const matches = (query: string): boolean => env().matchMedia?.(query).matches === true;

function probeStatic(): Omit<Capabilities, 'codecs' | 'keySystems'> {
  const g = env();
  const video = g.document?.createElement('video');
  const pip =
    g.document?.pictureInPictureEnabled === true ||
    typeof (video as { webkitSetPresentationMode?: unknown } | undefined)?.webkitSetPresentationMode === 'function';
  return {
    mediaSource: typeof g.MediaSource?.isTypeSupported === 'function',
    managedMediaSource: typeof g.ManagedMediaSource?.isTypeSupported === 'function',
    mseInWorker: g.MediaSource?.canConstructInDedicatedWorker === true,
    webCodecs: typeof g.VideoDecoder === 'function',
    nativeHls: (video?.canPlayType('application/vnd.apple.mpegurl') ?? '') !== '',
    pictureInPicture: pip,
    documentPictureInPicture: g.documentPictureInPicture !== undefined,
    orientationLock: typeof g.screen?.orientation?.lock === 'function',
    wakeLock: typeof g.navigator?.wakeLock?.request === 'function',
    sharedArrayBuffer: typeof g.SharedArrayBuffer === 'function',
    crossOriginIsolated: g.crossOriginIsolated === true,
    offscreenCanvas: typeof g.OffscreenCanvas === 'function',
    webgl2: typeof g.WebGL2RenderingContext === 'function',
    webgpu: typeof g.navigator?.gpu?.requestAdapter === 'function',
    coarsePointer: matches('(pointer: coarse)'),
    dynamicRange: matches('(dynamic-range: high)') ? 'high' : 'standard',
    colorGamut: matches('(color-gamut: rec2020)') ? 'rec2020' : matches('(color-gamut: p3)') ? 'p3' : 'srgb',
  };
}

/** `video/mp4; codecs="avc1.42E01E"` -> MediaCapabilities configuration for MSE playback. */
function decodingConfig(type: string): MediaDecodingConfiguration {
  if (type.startsWith('audio/')) {
    return { type: 'media-source', audio: { contentType: type, channels: '2', bitrate: 128_000, samplerate: 48_000 } };
  }
  return {
    type: 'media-source',
    video: { contentType: type, width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 },
  };
}

async function probeCodec(type: string): Promise<CodecDecodingInfo> {
  const g = env();
  const ms = g.MediaSource ?? g.ManagedMediaSource;
  const typeSupported = ms?.isTypeSupported(type) === true;
  const decodingInfo = g.navigator?.mediaCapabilities?.decodingInfo;
  if (decodingInfo !== undefined) {
    try {
      const info = await decodingInfo.call(g.navigator?.mediaCapabilities, decodingConfig(type));
      return { supported: info.supported && typeSupported, smooth: info.smooth, powerEfficient: info.powerEfficient };
    } catch {
      // Some engines reject unknown codec strings instead of answering `supported: false`.
    }
  }
  return { supported: typeSupported, smooth: typeSupported, powerEfficient: false };
}

async function probeKeySystem(keySystem: string): Promise<boolean> {
  const request = env().navigator?.requestMediaKeySystemAccess;
  if (request === undefined) return false;
  const config: MediaKeySystemConfiguration = {
    initDataTypes: ['cenc', 'sinf', 'skd', 'keyids'],
    videoCapabilities: [
      { contentType: 'video/mp4; codecs="avc1.42E01E"' },
      { contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
    ],
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), KEY_SYSTEM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request.call(env().navigator, keySystem, [config]).then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface CapabilityDetector {
  detect(options?: CapabilityProbeOptions): Promise<Capabilities>;
}

/** Detector with its own caches; `detectCapabilities` uses a shared default instance. */
export function createCapabilityDetector(): CapabilityDetector {
  let base: Omit<Capabilities, 'codecs' | 'keySystems'> | undefined;
  let codecCache = new Map<string, Promise<CodecDecodingInfo>>();
  let keyCache = new Map<string, Promise<boolean>>();

  const cached = <T>(cache: Map<string, Promise<T>>, key: string, probe: (k: string) => Promise<T>): Promise<T> => {
    let p = cache.get(key);
    if (p === undefined) {
      p = probe(key);
      cache.set(key, p);
    }
    return p;
  };

  return {
    async detect(options = {}) {
      if (options.refresh === true) {
        base = undefined;
        codecCache = new Map();
        keyCache = new Map();
      }
      try {
        base ??= probeStatic();
        const codecTypes = options.codecs ?? DEFAULT_PROBE_CODECS;
        const keySystems = options.keySystems ?? [];
        const [codecs, keys] = await Promise.all([
          Promise.all(codecTypes.map((t) => cached(codecCache, t, probeCodec))),
          Promise.all(keySystems.map((k) => cached(keyCache, k, probeKeySystem))),
        ]);
        return {
          ...base,
          codecs: Object.fromEntries(codecTypes.map((t, i) => [t, codecs[i] as CodecDecodingInfo])),
          keySystems: Object.fromEntries(keySystems.map((k, i) => [k, keys[i] === true])),
        };
      } catch (cause) {
        throw createError({
          type: 'other',
          details: 'capabilityDetectionFailed',
          fatal: true,
          recoverable: false,
          message: 'capability detection failed',
          cause,
        });
      }
    },
  };
}

let shared: CapabilityDetector | undefined;

export function detectCapabilities(options?: CapabilityProbeOptions): Promise<Capabilities> {
  shared ??= createCapabilityDetector();
  return shared.detect(options);
}
