// Derived from hls.js@b023c2908c53b8cbe25665de4df9713cd3bbfdbf src/demux/dummy-demuxed-track.ts, Apache-2.0
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
