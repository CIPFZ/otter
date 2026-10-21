// Single audible tab (SPEC §15, ADR-008 §8): a later start with sound mutes the others on the
// channel, a QoE `audio-yield` each; nothing comes back on pause or close.
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type OtterCore, type StoreSlice } from '@otter-player/core';
import { createSingleAudioPlugin, type SingleAudioActionMap } from '@otter-player/presentation/single-audio';

interface Media {
  readonly paused: boolean;
  readonly muted: boolean;
  readonly volume: number;
}
const MEDIA: StoreSlice<Media> = { id: 'media', initialState: { paused: true, muted: false, volume: 1 } };

const cores: OtterCore<Media, SingleAudioActionMap>[] = [];
let channel = 0;

async function players(n: number) {
  const name = `otter-audio-test-${++channel}`;
  const list = [];
  for (let i = 0; i < n; i++) {
    const core = createCore<Media, SingleAudioActionMap>({ slices: [MEDIA], plugins: [createSingleAudioPlugin({ channel: name })] });
    core.store.handle('set-muted', ({ muted }) => core.store.setState({ muted }));
    const yields: string[] = [];
    core.qoe.on('audio-yield', ({ to }) => void yields.push(to));
    await core.start();
    cores.push(core);
    list.push({ core, yields, set: (p: Partial<Media>) => core.store.setState(p), muted: () => core.store.getState().muted });
  }
  return list;
}
/** BroadcastChannel delivers asynchronously. */
const delivered = () => new Promise((r) => setTimeout(r, 30));
/** Date.now() moves on between two starts. */
const tick = () => new Promise((r) => setTimeout(r, 5));

afterEach(async () => {
  for (const c of cores.splice(0)) await c.destroy();
});

describe('single audio', () => {
  it('a later start with sound mutes the earlier one; nothing is restored after', async () => {
    const [a, b] = await players(2);
    a!.set({ paused: false });
    await tick();
    b!.set({ paused: false });
    await delivered();
    expect(a!.muted()).toBe(true);
    expect(b!.muted()).toBe(false);
    expect(a!.yields).toHaveLength(1);
    expect(b!.yields).toHaveLength(0);
    // B pauses, then goes away: A stays muted.
    b!.set({ paused: true });
    await cores[1]!.destroy();
    await delivered();
    expect(a!.muted()).toBe(true);
  });

  it('silent players are left alone: paused, muted or at volume 0', async () => {
    const [a, b, c, d] = await players(4);
    b!.set({ paused: false, muted: true });
    c!.set({ paused: false, volume: 0 });
    // a: paused.
    await tick();
    d!.set({ paused: false });
    await delivered();
    expect([a!.yields, b!.yields, c!.yields]).toEqual([[], [], []]);
    expect(a!.muted()).toBe(false);
    expect(c!.muted()).toBe(false);
  });

  it('the earlier one takes the sound back by unmuting (a new start with sound)', async () => {
    const [a, b] = await players(2);
    a!.set({ paused: false });
    await tick();
    b!.set({ paused: false });
    await delivered();
    expect(a!.muted()).toBe(true);
    await tick();
    a!.set({ muted: false });
    await delivered();
    expect(b!.muted()).toBe(true);
    expect(a!.muted()).toBe(false);
  });

  it('two starts at the same moment leave exactly one with sound', async () => {
    const [a, b] = await players(2);
    a!.set({ paused: false });
    b!.set({ paused: false });
    await delivered();
    expect([a!.muted(), b!.muted()].filter(Boolean)).toHaveLength(1);
  });
});
