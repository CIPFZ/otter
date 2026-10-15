// Derived from shaka-player@2ac882d23750d50c07a483b2786b1cb466398e8e demo/common/assets.js, Apache-2.0
//
// Copyright 2016 Google LLC. SPDX-License-Identifier: Apache-2.0. Subset of the Shaka demo asset
// list (REUSE §3 test stream list, L3); local changes are listed in ./UPSTREAM.json.

export interface PublicAsset {
  readonly name: string;
  readonly manifestUri: string;
  readonly live: boolean;
  readonly licenseServers?: Readonly<Record<string, string>>;
}

export const SHAKA_ASSETS = {
  angelOneDash: {
    name: 'Angel One (multicodec, multilingual)',
    manifestUri: 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
    live: false,
  },
  angelOneClearKey: {
    name: 'Angel One (multicodec, multilingual, ClearKey server)',
    manifestUri: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-clearkey/dash.mpd',
    live: false,
    licenseServers: {
      'org.w3.clearkey': 'https://cwip-shaka-proxy.appspot.com/clearkey?_u3wDe7erb7v8Lqt8A3QDQ=ABEiM0RVZneImaq7zN3u_w',
    },
  },
  lowLatencyDashLive: {
    name: 'Low Latency DASH Live',
    manifestUri: 'https://livesim2.dashif.org/livesim2/chunkdur_1/ato_7/testpic4_8s/Manifest300.mpd',
    live: true,
  },
} as const satisfies Record<string, PublicAsset>;
