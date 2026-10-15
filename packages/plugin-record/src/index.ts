// Recording plugin (SPEC §3 plugins). M0 empty implementation.

import { notImplemented, type Plugin } from '@otter-player/core';

export function createRecordPlugin(): Plugin {
  return {
    id: 'record',
    install: () => Promise.reject(notImplemented('@otter-player/plugin-record install')),
    uninstall: () => undefined,
  };
}
