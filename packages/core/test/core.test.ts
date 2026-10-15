import { describe, expect, it, vi } from 'vitest';
import {
  createCore,
  createError,
  createEventBus,
  createPluginRegistry,
  createQoeHook,
  createStore,
  isOtterError,
  notImplemented,
  type Plugin,
  type PluginContext,
  type SlicesState,
  type StoreSlice,
} from '@otter-player/core';

describe('errors', () => {
  it('creates throwable errors that satisfy the model', () => {
    const cause = new Error('socket closed');
    const err = createError({ type: 'network', details: 'fragLoadError', fatal: false, recoverable: true, cause });
    expect(err).toBeInstanceOf(Error);
    expect(isOtterError(err)).toBe(true);
    expect(err.cause).toBe(cause);
    expect(isOtterError({ type: 'network' })).toBe(false);
  });

  it('marks stubs as non-fatal notImplemented', () => {
    const err = notImplemented('x.y');
    expect(err).toMatchObject({ type: 'other', details: 'notImplemented', fatal: false });
    expect(err.message).toContain('x.y');
  });
});

describe('event bus', () => {
  interface Events {
    tick: number;
    named: { readonly name: string };
  }

  it('delivers typed payloads with trigger provenance', () => {
    const bus = createEventBus<Events>();
    const seen: unknown[] = [];
    bus.on('named', (p, meta) => seen.push(p.name, meta.type, meta.trigger?.type));
    bus.emit('named', { name: 'a' }, { type: 'keydown' });
    expect(seen).toEqual(['a', 'named', 'keydown']);
  });

  it('supports once and unsubscribe, including during delivery', () => {
    const bus = createEventBus<Events>();
    const once = vi.fn();
    const off = bus.on('tick', () => off());
    const after = vi.fn();
    bus.once('tick', once);
    bus.on('tick', after);
    bus.emit('tick', 1);
    bus.emit('tick', 2);
    expect(once).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('never swallows handler errors and still reaches every handler', () => {
    const bus = createEventBus<Events>();
    const last = vi.fn();
    bus.on('tick', () => {
      throw new Error('a');
    });
    bus.on('tick', () => {
      throw new Error('b');
    });
    bus.on('tick', last);
    expect(() => bus.emit('tick', 1)).toThrow(AggregateError);
    expect(last).toHaveBeenCalledOnce();
  });
});

describe('store', () => {
  const playback = { id: 'playback', initialState: { paused: true, currentTime: 0 } } satisfies StoreSlice;
  const volume = { id: 'volume', initialState: { volume: 1, muted: false } } satisfies StoreSlice;
  const slices = [playback, volume] as const;
  type State = SlicesState<typeof slices>;
  interface Actions {
    play: undefined;
    'set-volume': number;
  }

  it('merges slices and rejects conflicting keys', () => {
    const store = createStore<State, Actions>({ slices });
    expect(store.getState()).toEqual({ paused: true, currentTime: 0, volume: 1, muted: false });
    expect(Object.isFrozen(store.getState())).toBe(true);
    const dup = { id: 'dup', initialState: { paused: false } };
    expect(() => createStore({ slices: [playback, dup] })).toThrow(/declared by both/);
  });

  it('dispatches synchronously to handlers with trigger', () => {
    const store = createStore<State, Actions>({ slices });
    const triggers: unknown[] = [];
    store.handle('play', (_p, ctx) => {
      triggers.push(ctx.trigger?.type);
      ctx.setState({ paused: false });
    });
    const view = store.view();
    expect(view.dispatch('play', undefined, { type: 'click' })).toBe(true);
    // Synchronous: state is already updated when dispatch returns.
    expect(view.getState().paused).toBe(false);
    expect(triggers).toEqual(['click']);
    expect(view.dispatch('set-volume', 0.5)).toBe(false);
  });

  it('views cannot write state', () => {
    const view = createStore<State, Actions>({ slices }).view();
    expect('setState' in view).toBe(false);
    expect('handle' in view).toBe(false);
  });

  it('notifies subscribers only on change and supports selectors', () => {
    const store = createStore<State, Actions>({ slices });
    const all = vi.fn();
    const vol = vi.fn();
    store.subscribe(all);
    store.select((s) => s.volume, vol);
    store.setState({ volume: 1 });
    expect(all).not.toHaveBeenCalled();
    store.setState({ paused: false });
    expect(all).toHaveBeenCalledTimes(1);
    expect(vol).not.toHaveBeenCalled();
    store.setState({ volume: 0.2 });
    expect(vol).toHaveBeenCalledWith(0.2, 1);
  });
});

describe('plugin registry', () => {
  const ctx = (): PluginContext => {
    const core = createCore();
    return { store: core.store, events: core.events, qoe: core.qoe };
  };
  const plugin = (id: string, log: string[], deps?: readonly string[]): Plugin => ({
    id,
    ...(deps === undefined ? {} : { deps }),
    install: () => {
      log.push(`+${id}`);
    },
    uninstall: () => {
      log.push(`-${id}`);
    },
  });

  it('installs in topological order and uninstalls in reverse', async () => {
    const log: string[] = [];
    const reg = createPluginRegistry();
    reg.register(plugin('ui', log, ['media']));
    reg.register(plugin('media', log, ['core']));
    reg.register(plugin('core', log));
    reg.register(plugin('qoe', log));
    await reg.installAll(ctx());
    await reg.uninstallAll();
    expect(log).toEqual(['+core', '+media', '+ui', '+qoe', '-qoe', '-ui', '-media', '-core']);
  });

  it('rejects duplicates, missing deps and cycles', () => {
    const reg = createPluginRegistry();
    reg.register(plugin('a', [], ['b']));
    expect(() => reg.register(plugin('a', []))).toThrow(/already registered/);
    expect(() => reg.order()).toThrow(/unregistered "b"/);
    reg.register(plugin('b', [], ['a']));
    expect(() => reg.order()).toThrow(/cycle: a -> b -> a/);
  });

  it('rolls back on install failure', async () => {
    const log: string[] = [];
    const reg = createPluginRegistry();
    reg.register(plugin('a', log));
    reg.register({
      id: 'b',
      install: () => Promise.reject(new Error('boom')),
      uninstall: () => undefined,
    });
    await expect(reg.installAll(ctx())).rejects.toMatchObject({ details: 'pluginInstallFailed' });
    expect(log).toEqual(['+a', '-a']);
  });
});

describe('createCore', () => {
  it('wires store, events, qoe and plugins', async () => {
    const installed: string[] = [];
    const core = createCore({
      plugins: [{ id: 'p', install: () => undefined, uninstall: () => undefined }],
    });
    core.events.on('plugin-installed', ({ id }) => installed.push(id));
    await core.start();
    expect(installed).toEqual(['p']);
    await core.destroy();
  });

  it('qoe hook carries the route explanation', () => {
    const qoe = createQoeHook();
    const seen = vi.fn();
    qoe.on('route', seen);
    qoe.emit('route', { format: 'hls', backend: 'mse', steps: [] });
    expect(seen).toHaveBeenCalledOnce();
  });
});
