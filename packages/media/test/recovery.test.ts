import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore, createError } from '@otter-player/core';
import {
  createMediaPlugin,
  createRetryBudget,
  createStallWatchdog,
  DEFAULT_RECOVERY,
  EMPTY_TIME_RANGES,
  EMPTY_TRACKS,
  MEDIA_SLICE,
  NO_CAPABILITIES,
  resolveRecovery,
  type BackendEvents,
  type FormatPlugin,
  type MediaActionMap,
  type MediaBackend,
  type MediaState,
} from '@otter-player/media';

const net = (details = 'fragLoadError') => createError({ type: 'network', details, fatal: true, recoverable: true });

describe('retry budget', () => {
  it('backs off 1 s → 2 s → 4 s for network errors, then gives up', () => {
    const b = createRetryBudget(DEFAULT_RECOVERY);
    expect([b.next(net(), 0), b.next(net(), 0), b.next(net(), 0), b.next(net(), 0)]).toEqual([1000, 2000, 4000, null]);
  });

  it('allows one media retry, none for drm or unfixable details', () => {
    const b = createRetryBudget(DEFAULT_RECOVERY);
    const media = createError({ type: 'media', details: 'bufferAppendError', fatal: true, recoverable: false });
    expect(b.next(media, 0)).toBe(1000);
    expect(b.next(media, 0)).toBeNull();
    expect(b.next(createError({ type: 'drm', details: 'keySystemNoAccess', fatal: true, recoverable: false }), 0)).toBeNull();
    expect(b.next(net('mediaSrcNotSupported'), 0)).toBeNull();
  });

  it('healthy playback after resetAfterMs refills the budget', () => {
    const b = createRetryBudget(resolveRecovery({ retries: { network: 1 } }));
    expect(b.next(net(), 0)).toBe(1000);
    b.healthy(10_000);
    expect(b.next(net(), 10_000)).toBeNull();
    b.healthy(40_001);
    expect(b.next(net(), 40_001)).toBe(1000);
  });
});

describe('stall watchdog', () => {
  const sample = (now: number, currentTime: number, over: { playing?: boolean; bufferAhead?: number } = {}) => ({
    now,
    currentTime,
    playing: over.playing ?? true,
    bufferAhead: over.bufferAhead ?? 5,
  });

  it('a playhead that never moved is nudged after startupStallMs', () => {
    const w = createStallWatchdog(DEFAULT_RECOVERY);
    expect(w.sample(sample(0, 0.021))).toBe('none');
    expect(w.sample(sample(1_499, 0.021))).toBe('none');
    expect(w.sample(sample(1_500, 0.021))).toBe('nudge');
    // Freed by the nudge: from now on the regular timeout applies.
    expect(w.sample(sample(2_000, 0.2))).toBe('none');
    expect(w.sample(sample(4_000, 0.2))).toBe('none');
    expect(w.sample(sample(10_000, 0.2))).toBe('nudge');
  });

  it('the nudge itself is not progress: still stuck where it put the playhead escalates at the startup pace', () => {
    const w = createStallWatchdog(DEFAULT_RECOVERY);
    expect(w.sample(sample(0, 0))).toBe('none');
    expect(w.sample(sample(1_500, 0))).toBe('nudge');
    // The element reports the nudged position (0.1) and stays there: no picture is decoding.
    expect(w.sample(sample(1_600, 0.1))).toBe('none');
    expect(w.sample(sample(3_099, 0.1))).toBe('none');
    expect(w.sample(sample(3_100, 0.1))).toBe('escalate');
  });

  it('nudges after stallTimeoutMs with buffer ahead, escalates if still stuck', () => {
    const w = createStallWatchdog(DEFAULT_RECOVERY);
    expect(w.sample(sample(0, 2))).toBe('none');
    expect(w.sample(sample(100, 3))).toBe('none');
    expect(w.sample(sample(8_099, 3))).toBe('none');
    expect(w.sample(sample(8_100, 3))).toBe('nudge');
    expect(w.sample(sample(15_100, 3))).toBe('none');
    expect(w.sample(sample(16_100, 3))).toBe('escalate');
  });

  it('ignores paused playback, empty buffers and progress', () => {
    const w = createStallWatchdog(DEFAULT_RECOVERY);
    w.sample(sample(0, 3));
    expect(w.sample(sample(9_000, 3, { playing: false }))).toBe('none');
    expect(w.sample(sample(18_000, 3, { bufferAhead: 0.2 }))).toBe('none');
    expect(w.sample(sample(27_000, 3.5))).toBe('none');
    expect(w.sample(sample(30_000, 3.5))).toBe('none');
  });

  it('a nudge that frees the playhead re-arms the nudge', () => {
    const w = createStallWatchdog(DEFAULT_RECOVERY);
    w.sample(sample(0, 3));
    expect(w.sample(sample(8_000, 3))).toBe('nudge');
    w.sample(sample(9_000, 3.2));
    expect(w.sample(sample(17_000, 3.2))).toBe('nudge');
  });
});

// The session loads the codec ranking chunk on every load: warm it (fake timers below).
await import('../src/codecs.js');

describe('session stall handling', () => {
  afterEach(() => vi.useRealTimers());

  it('nudges a frozen playhead, then rebuilds the backend at the same position', async () => {
    vi.useFakeTimers();
    const created: { calls: string[]; emit: (e: keyof BackendEvents, p: unknown) => void }[] = [];
    const hls: FormatPlugin = { id: 'hls', probe: () => 1, backends: () => ['mse', 'native'], createEngine: () => { throw new Error('unused'); } };
    const factory = (kind: 'mse' | 'native') => ({
      kind,
      create: (): MediaBackend => {
        const calls: string[] = [];
        const listeners = new Map<string, Set<(p: unknown) => void>>();
        const b: MediaBackend = {
          kind,
          tracks: EMPTY_TRACKS,
          buffered: EMPTY_TIME_RANGES,
          attach: () => undefined,
          load: async (_s, o) => void calls.push(`load@${o.startTime ?? 0}`),
          play: () => Promise.resolve(),
          pause: () => undefined,
          seek: (t) => void calls.push(`seek:${t}`),
          setVolume: () => undefined,
          setMuted: () => undefined,
          setPlaybackRate: () => undefined,
          selectQuality: () => undefined,
          on(e, h) {
            let set = listeners.get(e);
            if (set === undefined) listeners.set(e, (set = new Set()));
            set.add(h as (p: unknown) => void);
            return () => set.delete(h as (p: unknown) => void);
          },
          destroy: () => void calls.push('destroy'),
        };
        created.push({ calls, emit: (e, p) => listeners.get(e)?.forEach((h) => h(p)) });
        return b;
      },
    });
    let clock = 0;
    const plugin = createMediaPlugin({
      target: {} as HTMLMediaElement,
      formats: [hls],
      backends: [factory('mse'), factory('native')],
      detect: async () => ({ ...NO_CAPABILITIES, mediaSource: true }),
      now: () => clock,
      // Steady-state path (the startup threshold has its own unit test).
      recovery: { backoffMs: () => 0, startupStallMs: 8_000 },
    });
    const core = createCore<MediaState, MediaActionMap>({ slices: [MEDIA_SLICE], plugins: [plugin] });
    const errors: string[] = [];
    core.qoe.on('error', ({ error }) => errors.push(`${error.details}:${error.fatal}`));
    await core.start();
    const view = core.store.view();
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await vi.advanceTimersByTimeAsync(0);
    created[0]?.emit('playback-change', { paused: false, currentTime: 5, bufferedEnd: 12, readyState: 4 });

    const advance = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 1000) {
        clock += 1000;
        await vi.advanceTimersByTimeAsync(1000);
      }
    };
    await advance(9_000);
    expect(created[0]?.calls).toContain('seek:5.1');
    expect(errors).toEqual(['playbackStalled:false']);
    await advance(9_000);
    expect(errors).toEqual(['playbackStalled:false', 'playbackStalled:true']);
    expect(created).toHaveLength(2);
    expect(created[1]?.calls).toContain('load@5');
    expect(view.getState()).toMatchObject({ status: 'ready', backend: 'mse' });
  });
});
