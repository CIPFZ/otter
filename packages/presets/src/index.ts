// Scenario presets (SPEC §2, §19): one pre-composed bundle per typical scenario. The scenario
// list is fixed by SPEC §3; preset contents and their size budgets ship in M6.

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
