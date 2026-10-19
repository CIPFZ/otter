import { describe, expect, it } from 'vitest';
import { createLiveController, type LiveSample } from '@otter-player/pipeline';

const s = (currentTime: number, end: number, over: Partial<LiveSample> = {}): LiveSample => ({
  currentTime,
  paused: false,
  buffered: [[Math.max(0, end - 20), end]],
  playbackRate: 1,
  readyState: 4,
  ...over,
});

describe('LiveController (mpegts.js rules, Otter policy)', () => {
  it('holds the target: catch-up rate above target + 0.4, back to 1x at target', () => {
    const lc = createLiveController({ targetLatency: 1 });
    expect(lc.sample(s(10, 11.2))).toBeUndefined(); // 1.2 s: inside the band
    expect(lc.sample(s(10, 11.5))).toEqual({ type: 'rate', rate: 1.2, reason: 'catch-up' });
    expect(lc.latency).toBeCloseTo(1.5);
    expect(lc.sample(s(10.4, 11.5, { playbackRate: 1.2 }))).toBeUndefined(); // 1.1: keep catching up
    expect(lc.sample(s(10.6, 11.5, { playbackRate: 1.2 }))).toEqual({ type: 'rate', rate: 1, reason: 'on-target' });
  });

  it('chases (seeks) when more than target + 1 behind', () => {
    const lc = createLiveController({ targetLatency: 1 });
    expect(lc.sample(s(10, 12.5))).toEqual({ type: 'seek', to: 11.5, reason: 'chase' });
  });

  it('never changes a rate the user chose, until back-to-live', () => {
    const lc = createLiveController({ targetLatency: 1 });
    // The user set 0.5x: latency grows, but the rate is theirs.
    expect(lc.sample(s(10, 11.6, { playbackRate: 0.5 }))).toBeUndefined();
    expect(lc.sample(s(10, 11.8, { playbackRate: 0.5 }))).toBeUndefined();
    // Too far behind still chases (a seek, not a rate change).
    expect(lc.sample(s(10, 13, { playbackRate: 0.5 }))).toMatchObject({ type: 'seek', reason: 'chase' });
    expect(lc.seekToLive(s(10, 13, { playbackRate: 1 }))).toEqual({ type: 'seek', to: 12, reason: 'seek-to-live' });
    expect(lc.sample(s(12, 13.5))).toEqual({ type: 'rate', rate: 1.2, reason: 'catch-up' });
  });

  it('does nothing while paused (upstream liveBufferLatencyChasingOnPaused: false)', () => {
    const lc = createLiveController();
    expect(lc.sample(s(10, 15, { paused: true }))).toBeUndefined();
  });

  it('jumps a playhead stuck before the first buffered range at startup', () => {
    const lc = createLiveController();
    const stuck: LiveSample = { currentTime: 0, paused: false, buffered: [[0.4, 3]], playbackRate: 1, readyState: 1 };
    expect(lc.sample(stuck)).toEqual({ type: 'seek', to: 0.4, reason: 'startup-stall' });
  });
});
