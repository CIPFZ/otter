// Casting (SPEC §15 投屏): Remote Playback API, AirPlay webkitShowPlaybackTargetPicker, Cast SDK. M0 empty implementation.

import { notImplemented, type Plugin } from '@otter-player/core';

export function createCastPlugin(): Plugin {
  return {
    id: 'cast',
    install: () => Promise.reject(notImplemented('@otter-player/plugin-cast install')),
    uninstall: () => undefined,
  };
}
