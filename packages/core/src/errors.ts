// Unified error model (SPEC §4). Categories mirror hls.js ErrorTypes so engine errors map 1:1.

/**
 * Where an error comes from, as hls.js's ErrorTypes: `network` (requests, connections), `media`
 * (decoding, playback, routing), `drm` (licenses, keys), `mux` (container parsing), `other`.
 */
export type OtterErrorType = 'network' | 'media' | 'drm' | 'mux' | 'other';

/**
 * Every error a player reports, on `events` (`error`) and in the store's `error`. Branch on
 * `details`, the stable code; the message is for logs only. A fatal error ends the load (the
 * session tries its recovery path first when `recoverable`); a non-fatal one is a notice.
 *
 * Codes (`*`: a prefix; Fatal "yes" ends the load):
 *
 * | Code | Type | Fatal | Raised by | When |
 * |---|---|---|---|---|
 * | `adapterLoadFailed` | media | yes | engine-pipeline | The engine adapter the own pipeline falls back to failed to load |
 * | `audioClockUnavailable` | media | no | backend-webcodecs | No audio clock: the picture runs on `performance.now()` |
 * | `audioOutputUnavailable` | media | no | backend-webcodecs | The audio output (AudioContext, worklet) could not start; video plays on |
 * | `audioUnderrun` | media | no | backend-webcodecs | The audio output ran dry (the message says for how long) |
 * | `audioUnsupported` | media | no | backend-webcodecs | No decoder for the audio codec; video plays without sound |
 * | `backendCreateFailed` | media | yes | media | The chosen backend's factory threw |
 * | `backendLoadFailed` | media | yes | media | The chosen backend failed to load the source |
 * | `backendMissing` | media | yes | media | The route chose a backend no factory was given for |
 * | `backendNotAttached` | other | yes | backend-mse, backend-native | The backend was used before attach() |
 * | `bufferAppendError` | media | yes | format-hls | MSE rejected a segment |
 * | `canvas2dUnavailable` | other | no | surface | No 2D context on the canvas |
 * | `capabilityDetectionFailed` | other | yes | media | Probing the device's codecs and APIs failed |
 * | `cmcdUnavailable` | other | no | media | CMCD was asked for but cannot be sent (the engine does not support it) |
 * | `codecUnknown` | mux | yes | demux-mediabunny | A track's codec has no decoder configuration |
 * | `codecUnsupported` | media | yes | backend-webcodecs | The decoder cannot decode the video codec |
 * | `decodeError` | media | yes | decoder-webcodecs, decoder-pool, decoder-wasm-hevc | The decoder failed on a frame |
 * | `decoderFallback` | media | no | backend-webcodecs | WebCodecs failed; decoding continues on the WASM decoder |
 * | `decoderQueued` | media | no | backend-webcodecs | Every decoder slot is busy: this stream waits for one |
 * | `decoderStalled` | media | yes | backend-webcodecs | No frame came out of the decoder for a while with packets in it |
 * | `decoderUnsupported` | media | yes | decoder-webcodecs | The decoder rejected the configuration (`NotSupportedError`) |
 * | `demuxFailed` | mux | yes | backend-webcodecs, demux-mediabunny | The container could not be parsed |
 * | `destroyed` | other | yes | backend-webcodecs | The backend was destroyed during a load |
 * | `engineLoadFailed` | other | yes | engine-adapter-mpegts, engine-adapter-shaka | The engine library loaded without its entry point |
 * | `engineUnsupported` | media | yes | engine adapters, engine-pipeline, format-hls, format-mp4-range | The engine cannot run in this browser (no MSE, ...) |
 * | `flv*` | mux | varies | pipeline | The FLV demuxer's error (`flvFormatError`, ...; format errors are not fatal) |
 * | `flvAborted` | network | yes | engine-pipeline | The FLV stream was aborted while opening |
 * | `flvBadHeader` | mux | yes | pipeline | The stream is not FLV |
 * | `flvOpenTimeout` | network | yes | engine-pipeline | No configuration and keyframe within the open timeout (10 s) |
 * | `flvRequestFailed` | network | yes | engine-pipeline | The FLV request failed or ended before it could play |
 * | `formatNeedsWebCodecs` | other | yes | format-file | format-file was routed to a backend other than WebCodecs |
 * | `fragLoadError` | network | yes | format-hls | A segment failed to load after the retries |
 * | `gpuContextLimit` | other | no | surface | Too many WebGL contexts: share one GPU grid between views |
 * | `gpuUnavailable` | other | no | presentation | No WebGL2: a wall takes at most a few streams on 2D canvases |
 * | `iceFailed` | network | yes | format-whep | The WebRTC connection failed |
 * | `liveOnly` | other | yes | format-flv, format-ts | FLV / TS on WebCodecs needs `live: true` (VOD goes through MSE) |
 * | `loadAborted` | other | no | backend-native, format-whep | A newer load or a teardown interrupted this one |
 * | `manifestLoadError` | network | yes | format-hls | The playlist failed to load after the retries |
 * | `mp4MoovNotFound` | media | yes | format-mp4-range | No `moov` box: not a playable MP4 |
 * | `mp4RangeError` | media | yes | format-mp4-range | The range engine failed |
 * | `mpegtsError` | varies | varies | engine-adapter-mpegts | mpegts.js reported an error without details (otherwise its own `details` pass through) |
 * | `noDecoder` | media | yes | backend-webcodecs | The route's decoder is not registered |
 * | `noDemuxer` | other | yes | backend-webcodecs | The format cannot feed WebCodecs |
 * | `noFormat` | media | yes | media | No format plugin can play the source |
 * | `noMediaFound` | media | yes | engine-pipeline | The stream ended before any media was found |
 * | `noRoute` | media | yes | media | No backend can play the source's format here |
 * | `noTrack` | mux | yes | demux-mediabunny | The asked-for track is not in the file |
 * | `noTracks` | mux | yes | demux-mediabunny | The file has neither audio nor video |
 * | `notABlob` | other | yes | format-file | format-file got a URL (it plays File / Blob sources) |
 * | `notAUrl` | other | yes | format-flv, format-hls, format-ts | The format got a File / Blob (it plays URLs) |
 * | `notImplemented` | other | no | any | The capability is not implemented: take another path |
 * | `ownEngineUnsupported` | media | yes | format-hls | The own HLS engine does not support the stream: hls.js takes over |
 * | `pipelineError` | media | yes | engine-pipeline | The own pipeline failed |
 * | `pipelineFallback` | other | no | engine-pipeline | The own pipeline handed the stream to an engine adapter |
 * | `playFailed` | media | no | media | `play()` failed for a reason other than autoplay policy |
 * | `playNotAllowed` | media | no | media | Autoplay policy refused `play()`: start muted or on a gesture |
 * | `playbackStalled` | media | no, then yes | media | The playhead is stuck; fatal (and recovered) once it stays stuck |
 * | `pluginDependencyCycle` | other | yes | core | Plugins depend on each other in a cycle |
 * | `pluginDuplicate` | other | yes | core | A plugin id is registered twice |
 * | `pluginInstallFailed` | other | yes | core | A plugin's install threw |
 * | `pluginMissingDependency` | other | yes | core | A plugin depends on one that is not registered |
 * | `pluginUninstallFailed` | other | yes | core | One or more plugins threw while uninstalling |
 * | `poolDestroyed` | other | yes | decoder-pool | The decode pool was used after destroy() |
 * | `rangeLoadError` | network | yes | format-mp4-range | A byte-range request failed |
 * | `segmentAbandoned` | network | no | format-hls | A segment download was abandoned for a lower quality (too slow) |
 * | `shaka*` | by category | by severity | engine-adapter-shaka | Shaka Player's error, `shaka` + its numeric code |
 * | `snapshotFailed` | other | no | surface | Encoding a snapshot failed |
 * | `snapshotTainted` | other | no | surface | The picture is cross-origin without CORS: no snapshot |
 * | `snapshotUnavailable` | other | no | surface | No picture to snapshot yet |
 * | `storeListenerError` | other | no | core | A state listener threw (the others still run) |
 * | `storeSliceConflict` | other | yes | core | Two slices declare the same state key |
 * | `streamLoadError` | network | yes | engine-pipeline | The live stream's request failed |
 * | `subtitleLoadError` | other | no | format-hls | A subtitle playlist or segment failed to load |
 * | `textTrackLoadFailed` | network | no | text | A sidecar caption file failed to load |
 * | `tooManyConnectionsPerHost` | network | no | presets (surveillance) | More than 6 HTTP/1.1 streams from one host: use WS-FLV or HTTP/2 |
 * | `tsDemuxFailed` | mux | yes | demux-mediabunny | The MPEG-TS stream could not be parsed |
 * | `tsRequestFailed` | network | yes | demux-mediabunny | The MPEG-TS request failed |
 * | `unsupportedSource` | other | yes | engine adapters, engine-pipeline, format-hls, format-mp4-range, format-whep | The engine got a source it cannot take (a Blob for a URL engine, ...) |
 * | `unsupportedTarget` | other | yes | backend-mse, backend-native | The backend needs a media element |
 * | `webgl2Unavailable` | other | no | surface | No WebGL2 context: the 2D canvas takes over |
 * | `whepRejected` | network | yes | format-whep | The WHEP endpoint refused the offer (HTTP status in the message) |
 * | `whepRequestFailed` | network | yes | format-whep | The WHEP request failed |
 * | `workerCrashed` | media | yes | decoder-pool | A decode worker crashed |
 * | `workerDecoderFailed` | media | yes | decoder-pool | The decoder inside a worker failed to start |
 *
 * hls.js's own `details` (`manifestLoadError`, `bufferStalledError`, ...) pass through unchanged
 * from engine-adapter-hlsjs, as do mpegts.js's from engine-adapter-mpegts.
 */
export interface OtterError {
  readonly type: OtterErrorType;
  /** The stable machine-readable code (the table above). */
  readonly details: string;
  /** The load cannot go on. */
  readonly fatal: boolean;
  /** The session may recover (retry, another route) before giving up. */
  readonly recoverable: boolean;
  /** The underlying error (a DOMException, a library's error object). */
  readonly cause?: unknown;
}

/** What createError takes: an error's fields and a message. */
export interface OtterErrorInit extends OtterError {
  /** Human-readable message for logs; not part of the stable model. */
  readonly message?: string;
}

class OtterErrorImpl extends Error implements OtterError {
  readonly type: OtterErrorType;
  readonly details: string;
  readonly fatal: boolean;
  readonly recoverable: boolean;

  constructor(init: OtterErrorInit) {
    super(init.message ?? init.details, 'cause' in init ? { cause: init.cause } : undefined);
    this.name = 'OtterError';
    this.type = init.type;
    this.details = init.details;
    this.fatal = init.fatal;
    this.recoverable = init.recoverable;
  }
}

/** Creates a throwable error that also satisfies the {@link OtterError} model. */
export function createError(init: OtterErrorInit): OtterError & Error {
  return new OtterErrorImpl(init);
}

/** Whether a value has the shape of an {@link OtterError} (thrown or emitted by any package). */
export function isOtterError(value: unknown): value is OtterError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof OtterError, unknown>>;
  return (
    typeof v.type === 'string' &&
    typeof v.details === 'string' &&
    typeof v.fatal === 'boolean' &&
    typeof v.recoverable === 'boolean'
  );
}

/** The `notImplemented` error of a capability not built yet: non-fatal, the caller takes another path. */
export function notImplemented(what: string): OtterError & Error {
  return createError({
    type: 'other',
    details: 'notImplemented',
    fatal: false,
    recoverable: false,
    message: `${what} is not implemented yet`,
  });
}
