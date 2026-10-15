// Unified video / audio / text track model shared by every backend (SPEC §5, §6.1).

export interface BaseTrack {
  readonly id: string;
  readonly label?: string;
  /** BCP 47 */
  readonly language?: string;
  readonly selected: boolean;
}

export interface VideoTrack extends BaseTrack {
  readonly kind: 'video';
  readonly codec?: string;
  readonly width?: number;
  readonly height?: number;
  /** bits per second */
  readonly bitrate?: number;
  readonly frameRate?: number;
  readonly dynamicRange?: 'sdr' | 'hdr10' | 'hlg' | 'dv';
}

export interface AudioTrack extends BaseTrack {
  readonly kind: 'audio';
  readonly codec?: string;
  readonly channels?: number;
  readonly bitrate?: number;
}

export interface TextTrackInfo extends BaseTrack {
  readonly kind: 'text';
  readonly role: 'subtitles' | 'captions' | 'forced' | 'descriptions' | 'chapters' | 'metadata';
  readonly format?: 'vtt' | 'ttml' | 'cea-608' | 'cea-708' | 'ass' | 'srt';
}

export type MediaTrack = VideoTrack | AudioTrack | TextTrackInfo;

export interface TrackList {
  /** Video renditions; `selectQuality` takes one of these ids. */
  readonly video: readonly VideoTrack[];
  readonly audio: readonly AudioTrack[];
  readonly text: readonly TextTrackInfo[];
  /** `opaque` when the backend cannot switch quality, e.g. Safari native HLS (SPEC §6.1). */
  readonly quality: 'selectable' | 'opaque';
  /** Requested quality id, or `auto`. */
  readonly requestedQuality: string;
}

export const EMPTY_TRACKS: TrackList = {
  video: [],
  audio: [],
  text: [],
  quality: 'opaque',
  requestedQuality: 'auto',
};

const outOfRange = (index: number): never => {
  throw new RangeError(`TimeRanges index ${index} out of range`);
};

/** Empty `TimeRanges` for backends that have nothing buffered (no DOM constructor exists). */
export const EMPTY_TIME_RANGES: TimeRanges = {
  length: 0,
  start: outOfRange,
  end: outOfRange,
};
