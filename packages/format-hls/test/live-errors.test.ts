import { afterEach, describe, expect, it, vi } from 'vitest';
import { createError, isOtterError } from '@otter-player/core';
import type { EngineInner } from '../src/own/engine.js';
import { startLive } from '../src/own/live.js';

afterEach(() => vi.useRealTimers());

describe('live playlist refresh errors', () => {
  it.each([
    ['network', 'manifestLoadError'],
    ['media', 'ownEngineUnsupported'],
  ] as const)('reports a fatal %s refresh error and stops reloading', async (type, details) => {
    vi.useFakeTimers();
    const error = createError({ type, details, fatal: true, recoverable: type === 'network' });
    const refresh = vi.fn(() => Promise.reject(error));
    const emit = vi.fn();
    const live = startLive({
      _media: new EventTarget() as HTMLMediaElement,
      _targetLatency: 1,
      _loadedAt: performance.now(),
      _track: () => ({ duration: Infinity, segments: [{ id: '1', startTime: 0, duration: 1 }], metadata: { mediaPlaylist: { targetDuration: 1 } } }),
      _window: () => undefined,
      _refresh: refresh,
      _core: { _isOtterError: isOtterError },
      _bus: { emit },
    } as unknown as EngineInner);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(emit).toHaveBeenCalledWith('error', error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      live._destroy();
    }
  });
});
