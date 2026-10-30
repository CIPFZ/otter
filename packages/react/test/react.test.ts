// @vitest-environment happy-dom
// The React bindings in a DOM: the player is made after mount inside a child of the box and goes
// with it; Strict Mode's double mount leaves one player; the state hook re-renders on its slice
// only; server markup hydrates without a mismatch.
import { act, createElement, StrictMode, useState, type ReactElement } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { OtterPlayer, useOtterState, type OtterStoreLike } from '../src/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
});

/** A store with getState / getInitialState / subscribe, as core's StoreView. */
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
    log.push(`create in ${container.parentElement?.getAttribute('data-otter-react') === '' ? 'box' : 'elsewhere'}, empty ${container.childElementCount === 0}`);
    container.append(document.createElement('video'));
    return { destroy: async () => void log.push('destroy') };
  };
}

describe('<OtterPlayer>', () => {
  it('makes the player after mount in a child of its box, hands it over, and destroys it (and the child) on unmount', async () => {
    const log: string[] = [];
    const seen: unknown[] = [];
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    await act(async () => root.render(createElement(OtterPlayer, { create: fakePlayer(log), onPlayer: (p) => seen.push(p === null ? null : 'player'), aspectRatio: '4 / 3' })));
    const box = host.querySelector('[data-otter-react]') as HTMLElement;
    expect(box.style.aspectRatio).toBe('4 / 3');
    expect(log).toEqual(['create in box, empty true']);
    expect(box.querySelectorAll('video')).toHaveLength(1);
    expect(seen).toEqual([null, 'player']);
    await act(async () => root.unmount());
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['create in box, empty true', 'destroy']);
    expect(host.querySelector('video')).toBeNull();
  });

  it('leaves exactly one player under Strict Mode (double effects and ref callbacks)', async () => {
    const log: string[] = [];
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    await act(async () => root.render(createElement(StrictMode, null, createElement(OtterPlayer, { create: fakePlayer(log) }))));
    await new Promise((r) => setTimeout(r, 0));
    // Every player made was made in an empty container of its own, and one is left.
    expect(log.filter((l) => l.startsWith('create')).every((l) => l === 'create in box, empty true')).toBe(true);
    expect(log.filter((l) => l.startsWith('create')).length - log.filter((l) => l === 'destroy').length).toBe(1);
    expect(host.querySelectorAll('video')).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('remakes the player when a dependency changes', async () => {
    const log: string[] = [];
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    await act(async () => root.render(createElement(OtterPlayer, { create: fakePlayer(log), deps: ['a.m3u8'] })));
    await act(async () => root.render(createElement(OtterPlayer, { create: fakePlayer(log), deps: ['a.m3u8'] })));
    expect(log).toHaveLength(1);
    await act(async () => root.render(createElement(OtterPlayer, { create: fakePlayer(log), deps: ['b.m3u8'] })));
    await new Promise((r) => setTimeout(r, 0));
    expect(log.sort()).toEqual(['create in box, empty true', 'create in box, empty true', 'destroy']);
    expect(host.querySelectorAll('video')).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('hydrates server markup without a mismatch, then makes the player', async () => {
    const log: string[] = [];
    const app = (): ReactElement => createElement(OtterPlayer, { create: fakePlayer(log), poster: '/poster.jpg', className: 'video' });
    const html = renderToString(app());
    expect(log).toEqual([]);
    const host = document.body.appendChild(document.createElement('div'));
    host.innerHTML = html;
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(host, app(), { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    expect(log).toEqual(['create in box, empty true']);
    expect(host.querySelector('[data-otter-react]')?.className).toBe('video');
    await act(async () => root?.unmount());
  });
});

describe('useOtterState', () => {
  it('reads a slice, re-renders only when it changes, and unsubscribes on unmount', async () => {
    const store = fakeStore({ currentTime: 0, paused: true });
    let renders = 0;
    let swap: (s: OtterStoreLike<{ currentTime: number; paused: boolean }> | null) => void = () => undefined;
    function Paused(): ReactElement {
      const [s, setS] = useState<OtterStoreLike<{ currentTime: number; paused: boolean }> | null>(store);
      swap = setS;
      const paused = useOtterState(s, (x) => x.paused);
      renders++;
      return createElement('span', null, paused === undefined ? 'none' : String(paused));
    }
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    await act(async () => root.render(createElement(Paused)));
    expect(host.textContent).toBe('true');
    const before = renders;
    await act(async () => store.set({ currentTime: 1 }));
    await act(async () => store.set({ currentTime: 2 }));
    expect(renders).toBe(before);
    await act(async () => store.set({ paused: false }));
    expect(host.textContent).toBe('false');
    expect(renders).toBe(before + 1);
    // No store (no player yet): undefined, and the old store is let go.
    await act(async () => swap(null));
    expect(host.textContent).toBe('none');
    expect(store.listeners).toBe(0);
    await act(async () => root.unmount());
  });

  it('keeps a selected object while equal by the given comparison', async () => {
    const store = fakeStore({ a: 1, b: 2, c: 0 });
    const values: unknown[] = [];
    function Pair(): ReactElement {
      const v = useOtterState(store, (x) => ({ a: x.a, b: x.b }), (p, q) => p.a === q.a && p.b === q.b);
      values.push(v);
      return createElement('i');
    }
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root.render(createElement(Pair)));
    await act(async () => store.set({ c: 1 }));
    await act(async () => store.set({ a: 5 }));
    expect(values).toHaveLength(2);
    expect(values[1]).toEqual({ a: 5, b: 2 });
    await act(async () => root.unmount());
  });

  it('renders the store\'s initial state on the server', () => {
    const store = fakeStore({ n: 1 });
    store.set({ n: 7 });
    const html = renderToString(createElement(() => createElement('b', null, String(useOtterState(store, (x) => x.n)))));
    expect(html).toBe('<b>1</b>');
  });
});
