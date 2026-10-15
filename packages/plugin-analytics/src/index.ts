// Analytics (SPEC §10): forwards core QoE events to a reporting endpoint. M0 empty implementation.

import { notImplemented, type Plugin } from '@otter-player/core';

export function createAnalyticsPlugin(): Plugin {
  return {
    id: 'analytics',
    install: () => Promise.reject(notImplemented('@otter-player/plugin-analytics install')),
    uninstall: () => undefined,
  };
}
