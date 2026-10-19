// Structural typing of the Shaka Player API subset the adapter uses. Shaka ships a Closure-style
// namespace declaration for a CommonJS bundle, which does not resolve cleanly under NodeNext
// interop; describing the surface we rely on keeps the adapter types independent of it.

export interface ShakaTrack {
  readonly id: number;
  readonly active: boolean;
  readonly type: string;
  readonly bandwidth: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly codecs: string | null;
  readonly hdr: string | null;
  readonly language: string;
  readonly label: string | null;
  readonly videoId: number | null;
  readonly audioId: number | null;
  readonly channelsCount: number | null;
  readonly audioBandwidth: number | null;
}

export interface ShakaTextTrack {
  readonly id: number;
  readonly active: boolean;
  readonly kind: string | null;
  readonly label: string | null;
  readonly language: string;
  readonly mimeType: string | null;
}

export interface ShakaAudioTrack {
  readonly id?: number;
  readonly active: boolean;
  readonly language: string;
  readonly label: string | null;
  readonly channelsCount: number | null;
}

export interface ShakaStats {
  readonly estimatedBandwidth: number;
  readonly liveLatency: number;
  readonly droppedFrames: number;
  readonly decodedFrames: number;
  readonly streamBandwidth: number;
}

export interface ShakaError {
  readonly severity: number;
  readonly category: number;
  readonly code: number;
  readonly message?: string;
}

export interface ShakaRequest {
  uris: string[];
  headers: Record<string, string>;
}

/** shaka.extern.RequestContext subset. */
export interface ShakaRequestContext {
  /** shaka.net.NetworkingEngine.AdvancedRequestType */
  readonly type?: number;
  readonly stream?: { readonly type?: string; readonly bandwidth?: number } | null;
  readonly segment?: { readonly startTime?: number; readonly endTime?: number } | null;
}

export interface ShakaNetworkingEngine {
  registerRequestFilter(filter: (type: number, request: ShakaRequest, context?: ShakaRequestContext) => void): void;
}

export interface ShakaPlayer {
  attach(media: HTMLMediaElement, initializeMediaSource?: boolean): Promise<unknown>;
  load(uri: string, startTime?: number | null, mimeType?: string | null): Promise<unknown>;
  configure(config: Record<string, unknown>): boolean;
  getVariantTracks(): ShakaTrack[];
  getTextTracks(): ShakaTextTrack[];
  selectVariantTrack(track: ShakaTrack, clearBuffer?: boolean): void;
  selectTextTrack(track: ShakaTextTrack): void;
  getAudioTracks?(): ShakaAudioTrack[];
  selectAudioTrack?(track: ShakaAudioTrack): void;
  setTextTrackVisibility(visible: boolean): void;
  getStats(): ShakaStats;
  isLive(): boolean;
  seekRange(): { readonly start: number; readonly end: number };
  /** Wall-clock distance from the live edge in ms (Shaka 5); null when unknown. */
  getLiveLatency?(): number | null;
  getNetworkingEngine(): ShakaNetworkingEngine | null;
  addEventListener(type: string, listener: (event: { detail?: unknown }) => void): void;
  destroy(): Promise<unknown>;
}

export interface ShakaNamespace {
  readonly Player: { new (): ShakaPlayer; isBrowserSupported(): boolean };
  readonly polyfill: { installAll(): void };
}

/** The CommonJS bundle may arrive as `mod`, `mod.default` or `mod.default.default`. */
export function resolveShakaNamespace(mod: unknown): ShakaNamespace | undefined {
  let current: unknown = mod;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
    if ('Player' in current && 'polyfill' in current) return current as ShakaNamespace;
    current = (current as { default?: unknown }).default;
  }
  return undefined;
}
