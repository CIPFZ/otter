// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de tests/test-streams.js, Apache-2.0
//
// Copyright (c) 2017 Dailymotion (http://www.dailymotion.com). Licensed under the Apache License,
// Version 2.0. Subset of the hls.js functional-test streams (REUSE §3 test stream list, L3);
// local changes are listed in ./UPSTREAM.json.

export interface PublicStream {
  readonly url: string;
  readonly description: string;
  readonly live: boolean;
  readonly abr: boolean;
}

export const HLSJS_STREAMS = {
  bbb: {
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    description: 'Big Buck Bunny - adaptive qualities',
    live: false,
    abr: true,
  },
  closedCaptions: {
    url: 'https://playertest.longtailvideo.com/adaptive/captions/playlist.m3u8',
    description: 'CNN special report, with CC',
    live: false,
    abr: false,
  },
  fmp4: {
    url: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8',
    description: 'HLS fMP4 Angel-One multiple audio-tracks',
    live: false,
    abr: true,
  },
  MuxLowLatencyHls: {
    url: 'https://stream.mux.com/v69RSHhFelSm4701snP22dYz2jICy4E4FUyk02rW4gxRM.m3u8',
    description:
      'Low-Latency HLS sample of Big Buck Bunny loop and a timer. Restarts every 12 hours. (fMP4 segments)',
    live: true,
    abr: true,
  },
} as const satisfies Record<string, PublicStream>;
