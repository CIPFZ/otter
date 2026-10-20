// Demuxer boundary of the WebCodecs path (SPEC §6.3, ADR-008 §2). Formats that can feed WebCodecs
// (format-file, later format-hls) produce a Demuxer; the backend pulls encoded packets from it
// and hands them to a Decoder. Packets carry codec-ready decoder configs, so the backend (and a
// future Worker pool) never parses containers.

import type { DecoderConfig } from './decoder.js';

/** What a Decoder needs to configure itself, without the callbacks of DecoderConfig. */
export type DecodeSetup = Omit<DecoderConfig, 'output' | 'error' | 'hardwareAcceleration'>;

export interface DemuxTrack {
  /** Track id inside the container. */
  readonly id: number;
  readonly setup: DecodeSetup;
  /** Codec string as stored in the container (RFC 6381), for routing and reporting. */
  readonly codec: string;
  readonly bitrate?: number;
}

export interface DemuxVideoTrack extends DemuxTrack {
  readonly width: number;
  readonly height: number;
  /** Frames per second from packet timing, when it can be measured cheaply. */
  readonly frameRate?: number;
}

export interface DemuxAudioTrack extends DemuxTrack {
  readonly sampleRate: number;
  readonly channels: number;
}

/** Tracks and timing of a source, after `open()`. Times in seconds. */
export interface DemuxInfo {
  readonly duration: number;
  /** Timestamp of the first packet; media time 0 starts here. */
  readonly startTime: number;
  readonly video: DemuxVideoTrack | null;
  readonly audio: DemuxAudioTrack | null;
}

/** Encoded packets of one track, in decode order. EOS is the end of the iterator. */
export type PacketStream = AsyncIterable<import('./decoder.js').EncodedChunk>;
