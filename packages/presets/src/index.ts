// Scenario presets (SPEC §2, §19, ADR-013): createPlayer assembles a player around a <video>; one
// sub-path per scenario composes it (`@otter-player/presets/vod`, `/live`, `/background`, ...), so a
// page carries only its scenario's formats and backends.

export { createPlayer, type Player, type PlayerActions, type PlayerExplanation, type PlayerOptions, type PlayerParts, type PlayerState } from './player.js';
export type { PresetOptions } from './options.js';

export type PresetId =
  | 'vod'
  | 'live'
  | 'lowlatency'
  | 'ott-drm'
  | 'surveillance'
  | 'danmaku'
  | 'shorts'
  | 'tv'
  | 'background';

export const PRESET_IDS: readonly PresetId[] = [
  'vod',
  'live',
  'lowlatency',
  'ott-drm',
  'surveillance',
  'danmaku',
  'shorts',
  'tv',
  'background',
];
