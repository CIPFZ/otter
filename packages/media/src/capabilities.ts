// Capability detection (SPEC §5.1): probed once, cached, and fed to FormatPlugin.probe and the router.

import { notImplemented } from '@otter-player/core';

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
  /** MIME + codecs strings to run through `decodingInfo`. */
  readonly codecs?: readonly string[];
  readonly keySystems?: readonly string[];
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

export function detectCapabilities(_options?: CapabilityProbeOptions): Promise<Capabilities> {
  return Promise.reject(notImplemented('@otter-player/media detectCapabilities'));
}
