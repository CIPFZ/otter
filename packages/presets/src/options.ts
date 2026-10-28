// Options every scenario preset takes: createPlayer's, minus what the preset decides (formats and
// backends). Only `container` is required.

import type { PlayerActions, PlayerOptions, PlayerState } from './player.js';

export type PresetOptions<S extends PlayerState = PlayerState, A extends PlayerActions = PlayerActions> = Omit<PlayerOptions<S, A>, 'formats' | 'backends'>;
