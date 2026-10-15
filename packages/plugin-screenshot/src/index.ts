// Screenshot plugin (SPEC §3 plugins): frames come from Surface.snapshot. M0 empty implementation.

import { notImplemented, type Plugin } from '@otter-player/core';

export function createScreenshotPlugin(): Plugin {
  return {
    id: 'screenshot',
    install: () => Promise.reject(notImplemented('@otter-player/plugin-screenshot install')),
    uninstall: () => undefined,
  };
}
