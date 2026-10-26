// SPEC §19 scenario matrix, M1 scope (ADR-003 §8). Each entry is the playback part of a scenario;
// modules of later milestones (danmaku M5, GPUSurface M4, TV skin M6, ...) are named in `later`.

import { HLSJS_STREAMS } from './vendor/hls.js/test-streams.ts';
import { SHAKA_ASSETS } from './vendor/shaka-player/assets.ts';
import keys from './media/keys.json' with { type: 'json' };

export type Requirement = 'clearkey' | 'hevc' | 'mms';

export interface Scenario {
  readonly id: string;
  /** SPEC §19 row. */
  readonly row: string;
  readonly source: Record<string, unknown> & { readonly src: string };
  /** Load the source as a Blob fetched in the page (local file scenario). */
  readonly asBlob?: boolean;
  /** Needs the public internet; tagged @network. */
  readonly network?: boolean;
  /** Without these the scenario must fail gracefully with a full route explanation. */
  readonly requires?: readonly Requirement[];
  readonly checks?: readonly ('quality-switch' | 'subtitles' | 'live-latency')[];
  /** Expected format id. */
  readonly format: string;
  /** What of the row is not in M1. */
  readonly later?: string;
}

const clearKey = { [keys['dash-clearkey'].kid]: keys['dash-clearkey'].key };

export const SCENARIOS: readonly Scenario[] = [
  { id: 'short-vod-mp4', row: '短视频 / 简单点播', source: { src: '/vod/progressive.mp4' }, format: 'mp4-range', later: 'mp4 Range segment loading (M3), minimal skin (M2)' },
  { id: 'long-vod-hls-ts', row: '长视频点播 + 多清晰度 + 字幕', source: { src: '/hls-ts/master.m3u8' }, format: 'hls', checks: ['quality-switch', 'subtitles'], later: 'ABR rules (M2), caption rendering (M2), thumbnails' },
  { id: 'long-vod-hls-fmp4', row: '长视频点播 + 多清晰度 + 字幕', source: { src: '/hls-fmp4/master.m3u8' }, format: 'hls', checks: ['quality-switch', 'subtitles'] },
  { id: 'long-vod-dash', row: '长视频点播 + 多清晰度 + 字幕', source: { src: '/dash/manifest.mpd' }, format: 'dash', checks: ['quality-switch'] },
  { id: 'live-ll-hls', row: '直播 + LL-HLS / LL-DASH', source: { src: HLSJS_STREAMS.MuxLowLatencyHls.url, live: true }, format: 'hls', network: true, checks: ['live-latency'], later: 'LiveController (M3)' },
  { id: 'live-ll-dash', row: '直播 + LL-HLS / LL-DASH', source: { src: SHAKA_ASSETS.lowLatencyDashLive.manifestUri, live: true }, format: 'dash', network: true, checks: ['live-latency'] },
  { id: 'cn-live-flv', row: '国内直播 / 电商', source: { src: '/live/stream.flv', live: true }, format: 'flv', checks: ['live-latency'], later: 'own FLV pipeline + watchdogs (M3), WHEP (M4)' },
  { id: 'cn-vod-ts', row: '国内直播 / 电商', source: { src: '/ts/clip.ts' }, format: 'ts' },
  { id: 'camera-ts-video-only', row: '监控多路 + HEVC', source: { src: '/ts/clip-video-only.ts' }, format: 'ts', later: 'H.264 video-only camera stream; HEVC / multi-view in M4' },
  { id: 'ott-clearkey-local', row: 'OTT 付费 + DRM + 离线', source: { src: '/dash-clearkey/manifest.mpd', drm: { servers: {}, clearKeys: clearKey } }, format: 'dash', requires: ['clearkey'], later: 'offline storage, ads' },
  { id: 'ott-clearkey-server', row: 'OTT 付费 + DRM + 离线', source: { src: SHAKA_ASSETS.angelOneClearKey.manifestUri, drm: { servers: SHAKA_ASSETS.angelOneClearKey.licenseServers } }, format: 'dash', network: true, requires: ['clearkey'] },
  // HEVC HLS: MSE when the browser has HEVC, else format-hls feeds WebCodecs (hardware) or the WASM
  // decoder (ADR-008 §5); no longer a graceful failure.
  { id: 'surveillance-hevc', row: '监控多路 + HEVC', source: { src: 'https://bitmovin-a.akamaihd.net/content/dataset/multi-codec/hevc/stream_fmp4.m3u8', codecs: 'hvc1.1.6.L93.90,mp4a.40.2' }, format: 'hls', network: true },
  { id: 'surveillance-hevc-local', row: '监控多路 + HEVC', source: { src: '/frames/hls-hevc/master.m3u8', codecs: 'hvc1.1.6.L93.90' }, format: 'hls' },
  // Separate audio / video, three video tiers, two audio languages (codec choice and audio outside
  // ABR: dash-av.spec.ts; preferences: codecs-prefs.spec.ts).
  { id: 'danmaku-dash-av', row: 'B 站式弹幕站', source: { src: '/dash-av/manifest.mpd' }, format: 'dash', later: 'danmaku (M5 batch 4)' },
  // A local file goes to format-file on WebCodecs (frame-accurate seek, ADR-008 §2).
  { id: 'edit-local-file', row: '剪辑 / 标注 / 逐帧', source: { src: '/vod/progressive.mp4' }, asBlob: true, format: 'file' },
  { id: 'background-hero', row: '背景视频 / Hero', source: { src: '/vod/progressive.mp4' }, format: 'mp4-range', later: 'no-UI preset (M6)' },
  { id: 'shorts-vertical', row: '沉浸竖屏信息流', source: { src: '/vod/vertical.mp4' }, format: 'mp4-range', later: 'shorts preset with preloaded neighbours (M6)' },
  { id: 'tv-hls', row: '电视遥控器', source: { src: '/hls-fmp4/master.m3u8' }, format: 'hls', later: 'ui-skin-tv (M6); real TV device required' },
];
