// Reserved P2P-CDN plugin; whether it ships in v1 is open (SPEC §23 Q4). M0 empty implementation.

import { notImplemented, type Plugin } from '@otter-player/core';

export function createP2pPlugin(): Plugin {
  return {
    id: 'p2p',
    install: () => Promise.reject(notImplemented('@otter-player/plugin-p2p install')),
    uninstall: () => undefined,
  };
}
