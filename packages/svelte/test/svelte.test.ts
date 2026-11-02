// @vitest-environment happy-dom
// The Svelte bindings in a DOM: the component (through the action) makes the player after mount in
// a child of its box and destroys it with it; deps remake it; the store adapter follows its slice
// only. Hydration of real server markup: e2e/svelte.spec.ts (here the component is compiled for the
// DOM only).
import { describe, expect, it } from 'vitest';
// The client runtime: in a node-condition test run 'svelte' resolves to the server build.
const { flushSync, mount, unmount } = (await import('../../../node_modules/svelte/src/index-client.js' as string)) as typeof import('svelte');
import OtterPlayer from '../src/OtterPlayer.svelte';
import { otterPlayer, otterState } from '../src/index.js';

function fakeStore<S extends object>(initial: S) {
  let state = initial;
  const listeners = new Set<(s: S, p: S) => void>();
  return {
    getState: () => state,
    getInitialState: () => initial,
    subscribe(l: (s: S, p: S) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(patch: Partial<S>) {
      const prev = state;
      state = { ...state, ...patch };
      for (const l of listeners) l(state, prev);
    },
    get listeners() {
      return listeners.size;
    },
  };
}

function fakePlayer(log: string[]) {
  return (container: HTMLElement) => {
    log.push(`create in ${container.parentElement?.hasAttribute('data-otter-svelte') === true ? 'box' : 'elsewhere'}, empty ${container.childElementCount === 0}`);
    container.append(document.createElement('video'));
    return { destroy: async () => void log.push('destroy') };
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('<OtterPlayer> (Svelte)', () => {
  it('makes the player after mount in a child of its box, hands it over, and destroys it (and the child) on unmount', async () => {
    const log: string[] = [];
    const seen: unknown[] = [];
    const host = document.body.appendChild(document.createElement('div'));
    const c = mount(OtterPlayer, { target: host, props: { create: fakePlayer(log), aspectRatio: '4 / 3', onplayer: (p: unknown) => seen.push(p === null ? null : 'player') } });
    flushSync();
    const box = host.querySelector('[data-otter-svelte]') as HTMLElement;
    expect(box.style.aspectRatio).toBe('4 / 3');
    expect(log).toEqual(['create in box, empty true']);
    expect(box.querySelectorAll('video')).toHaveLength(1);
    expect(seen).toEqual(['player']);
    await unmount(c);
    await settle();
    expect(log).toEqual(['create in box, empty true', 'destroy']);
    expect(seen).toEqual(['player', null]);
    expect(host.querySelector('video')).toBeNull();
  });
});

describe('otterPlayer action', () => {
  it('remakes the player when a dependency changes, not otherwise', async () => {
    const log: string[] = [];
    const node = document.body.appendChild(document.createElement('div'));
    node.setAttribute('data-otter-svelte', '');
    const a = otterPlayer(node, { create: fakePlayer(log), deps: ['a.m3u8'] });
    a.update({ create: fakePlayer(log), deps: ['a.m3u8'] });
    expect(log).toHaveLength(1);
    a.update({ create: fakePlayer(log), deps: ['b.m3u8'] });
    await settle();
    expect(log.sort()).toEqual(['create in box, empty true', 'create in box, empty true', 'destroy']);
    expect(node.querySelectorAll('video')).toHaveLength(1);
    a.destroy();
  });
});

describe('otterState', () => {
  it('runs on a change of its slice only, and lets the store go on unsubscribe', () => {
    const store = fakeStore({ currentTime: 0, paused: true });
    const seen: unknown[] = [];
    const off = otterState(store, (s) => s.paused).subscribe((v) => seen.push(v));
    store.set({ currentTime: 1 });
    store.set({ paused: false });
    expect(seen).toEqual([true, false]);
    off();
    expect(store.listeners).toBe(0);
    const none: unknown[] = [];
    otterState(null, (s: { paused: boolean }) => s.paused).subscribe((v) => none.push(v))();
    expect(none).toEqual([undefined]);
  });
});
