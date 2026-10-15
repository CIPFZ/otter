// Source description handed in by the host (SPEC §16 host contract).

/** Well-known EME key systems; any other string is accepted for vendor CDMs. */
export type KeySystem =
  | 'com.widevine.alpha'
  | 'com.microsoft.playready'
  | 'com.apple.fps'
  | 'org.w3.clearkey'
  | (string & {});

export interface DrmConfig {
  /** License server URL per key system; maps 1:1 to Shaka `drm.servers` (DRM goes through Shaka only). */
  readonly servers: Readonly<Record<KeySystem, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** FairPlay server certificate URL. */
  readonly serverCertificateUrl?: string;
}

export interface Source {
  readonly src: string | Blob;
  /** MIME hint: `application/vnd.apple.mpegurl`, `application/dash+xml`, `video/x-flv`, `video/mp4`, ... */
  readonly type?: string;
  readonly drm?: DrmConfig;
  readonly live?: boolean;
  /**
   * Alternate source for AirPlay. iPhone ManagedMediaSource refuses to start without either an
   * AirPlay alternate or `disableRemotePlayback` (RESEARCH §1).
   */
  readonly airplaySrc?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface LoadOptions {
  /** Seconds. */
  readonly startTime?: number;
  readonly autoplay?: boolean;
  /** Quality id, or `auto` (default). */
  readonly quality?: string;
  readonly signal?: AbortSignal;
}
