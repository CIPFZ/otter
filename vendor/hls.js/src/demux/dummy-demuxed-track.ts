// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/demux/dummy-demuxed-track.ts, Apache-2.0
import type { DemuxedTrack } from '../types/demuxer.js';

export function dummyTrack(type = '', inputTimeScale = 90000): DemuxedTrack {
  return {
    type,
    id: -1,
    pid: -1,
    inputTimeScale,
    sequenceNumber: -1,
    samples: [],
    dropped: 0,
  };
}
