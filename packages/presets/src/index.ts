// Scenario presets (SPEC §2, §19, ADR-013): createPlayer assembles a player around a <video>; one
// sub-path per scenario composes it (`@otter-player/presets/vod`, `/live`, `/background`, ...), so a
// page carries only its scenario's formats and backends. `basic` (the short-VOD row) is assembled on
// its own, without createPlayer, to stay within 30 KB.

export { createPlayer, type Player, type PlayerActions, type PlayerExplanation, type PlayerOptions, type PlayerParts, type PlayerState } from './player.js';
export type { PresetOptions } from './options.js';

/** The id of a scenario preset: its sub-path, `@otter-player/presets/<id>`. */
export type PresetId =
  | 'basic'
  | 'vod'
  | 'live'
  | 'lowlatency'
  | 'ott-drm'
  | 'surveillance'
  | 'danmaku'
  | 'shorts'
  | 'tv'
  | 'background';

/** Every preset id, in the order of SPEC §19's scenario table. */
export const PRESET_IDS: readonly PresetId[] = [
  'basic',
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
