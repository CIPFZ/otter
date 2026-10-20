// WebCodecs backend (SPEC §6.3, ADR-008 §2): demuxed packets -> Decoder plugin -> FrameSurface,
// AudioContext master clock.

import type { BackendFactory } from '@otter-player/media';
import { createWebCodecsBackend, type WebCodecsBackendOptions } from './backend.js';

export { createWebCodecsBackend, type WebCodecsBackendOptions } from './backend.js';
export { createClock, type ClockAnchor, type MediaClock } from './clock.js';

export function createWebCodecsBackendFactory(options: WebCodecsBackendOptions): BackendFactory {
  return { kind: 'webcodecs', create: (ctx) => createWebCodecsBackend(ctx, options) };
}
