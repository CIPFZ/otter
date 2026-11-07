// @vitest-environment happy-dom
// The Vue bindings in a DOM: the player is made after mount inside a child of the box and goes with
// it; deps remake it; the state composable updates on its slice only; server markup hydrates
// without a mismatch.
import { createApp, createSSRApp, defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OtterPlayer, useOtterState, type OtterStoreLike } from '../src/index.js';

afterEach(() => {
  document.body.innerHTML = '';
});

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
    log.push(`create in ${container.parentElement?.hasAttribute('data-otter-vue') === true ? 'box' : 'elsewhere'}, empty ${container.childElementCount === 0}`);
    container.append(document.createElement('video'));
    return { destroy: async () => void log.push('destroy') };
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('<OtterPlayer> (Vue)', () => {
  it('makes the player after mount in a child of its box, emits it, and destroys it (and the child) on unmount', async () => {
    const log: string[] = [];
    const seen: unknown[] = [];
    const host = document.body.appendChild(document.createElement('div'));
    const app = createApp({ render: () => h(OtterPlayer, { create: fakePlayer(log), aspectRatio: '4 / 3', onPlayer: (p: unknown) => seen.push(p === null ? null : 'player') }) });
    app.mount(host);
    await nextTick();
    const box = host.querySelector('[data-otter-vue]') as HTMLElement;
    expect(box.style.aspectRatio).toBe('4 / 3');
    expect(log).toEqual(['create in box, empty true']);
    expect(box.querySelectorAll('video')).toHaveLength(1);
    expect(seen).toEqual(['player']);
    app.unmount();
    await settle();
    expect(log).toEqual(['create in box, empty true', 'destroy']);
    expect(host.querySelector('video')).toBeNull();
    expect(seen).toEqual(['player', null]);
  });

  it('remakes the player when a dependency changes', async () => {
    const log: string[] = [];
    const src = ref('a.m3u8');
    const host = document.body.appendChild(document.createElement('div'));
    const app = createApp({ render: () => h(OtterPlayer, { create: fakePlayer(log), deps: [src.value] }) });
    app.mount(host);
    await nextTick();
    src.value = 'a.m3u8';
    await nextTick();
    expect(log).toHaveLength(1);
    src.value = 'b.m3u8';
    await nextTick();
    await settle();
    expect(log.sort()).toEqual(['create in box, empty true', 'create in box, empty true', 'destroy']);
    expect(host.querySelectorAll('video')).toHaveLength(1);
    app.unmount();
  });

  it('hydrates server markup without a mismatch, then makes the player', async () => {
    const log: string[] = [];
    const root = () => h(OtterPlayer, { create: fakePlayer(log), poster: '/poster.jpg' });
    const html = await renderToString(createSSRApp({ render: root }));
    expect(log).toEqual([]);
    const host = document.body.appendChild(document.createElement('div'));
    host.innerHTML = html;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createSSRApp({ render: root });
    app.mount(host);
    await nextTick();
    const mismatch = [...warn.mock.calls, ...error.mock.calls].map((c) => String(c[0])).filter((m) => /hydration/i.test(m));
    warn.mockRestore();
    error.mockRestore();
    expect(mismatch).toEqual([]);
    expect(log).toEqual(['create in box, empty true']);
    app.unmount();
  });
});

describe('useOtterState (Vue)', () => {
  it('follows a slice, updates only when it changes, follows a new store and lets the old one go', async () => {
    const store = fakeStore({ currentTime: 0, paused: true });
    const other = fakeStore({ currentTime: 0, paused: false });
    const current: Ref<OtterStoreLike<{ currentTime: number; paused: boolean }> | null> = ref(store);
    let renders = 0;
    const host = document.body.appendChild(document.createElement('div'));
    const app = createApp(
      defineComponent(() => {
        const paused = useOtterState(current, (s) => s.paused);
        return () => {
          renders++;
          return h('span', paused.value === undefined ? 'none' : String(paused.value));
        };
      }),
    );
    app.mount(host);
    await nextTick();
    expect(host.textContent).toBe('true');
    const before = renders;
    store.set({ currentTime: 1 });
    store.set({ currentTime: 2 });
    await nextTick();
    expect(renders).toBe(before);
    store.set({ paused: false });
    await nextTick();
    expect(host.textContent).toBe('false');
    current.value = other;
    await nextTick();
    expect(store.listeners).toBe(0);
    expect(other.listeners).toBe(1);
    current.value = null;
    await nextTick();
    expect(host.textContent).toBe('none');
    app.unmount();
    expect(other.listeners).toBe(0);
  });

  it("renders the store's initial state on the server, without subscribing", async () => {
    const store = fakeStore({ n: 1 });
    store.set({ n: 7 });
    const html = await renderToString(createSSRApp(defineComponent(() => {
      const n = useOtterState(store, (s) => s.n);
      return () => h('b', String(n.value));
    })));
    expect(html).toBe('<b>1</b>');
    expect(store.listeners).toBe(0);
  });
});
