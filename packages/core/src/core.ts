// Core assembly: the host passes slices (from `features`) and plugins, listens to events and
// dispatches actions (SPEC §16 host contract).

import { createError } from './errors.js';
import { createEventBus, type EventBus } from './events.js';
import { createPluginRegistry, type CoreEventMap, type Plugin, type PluginRegistry } from './plugin.js';
import { createQoeHook, type QoeHook } from './qoe.js';
import { createStore, type Store, type StoreSlice } from './store.js';

export interface CoreOptions<S extends object, A extends object> {
  readonly slices?: readonly StoreSlice[];
  readonly plugins?: readonly Plugin<S, A>[];
}

export interface OtterCore<S extends object, A extends object> {
  readonly store: Store<S, A>;
  readonly events: EventBus<CoreEventMap>;
  readonly qoe: QoeHook;
  readonly plugins: PluginRegistry<S, A>;
  /** Installs every registered plugin in dependency order. */
  start(): Promise<void>;
  destroy(): Promise<void>;
}

export function createCore<S extends object, A extends object = Record<never, never>>(
  options: CoreOptions<S, A> = {},
): OtterCore<S, A> {
  const events = createEventBus<CoreEventMap>();
  // A state listener that throws (a UI or framework binding) is reported as an error event; the
  // engine's setState and the other listeners carry on.
  const store = createStore<S, A>({
    slices: options.slices ?? [],
    onListenerError: (cause) =>
      events.emit('error', createError({ type: 'other', details: 'storeListenerError', fatal: false, recoverable: true, message: `state listener threw: ${String(cause)}`, cause })),
  });
  const qoe = createQoeHook();
  const plugins = createPluginRegistry<S, A>();
  for (const p of options.plugins ?? []) plugins.register(p);

  return {
    store,
    events,
    qoe,
    plugins,
    start: () => plugins.installAll({ store, events, qoe }),
    async destroy() {
      try {
        await plugins.uninstallAll();
      } finally {
        events.clear();
        qoe.clear();
        store.destroy();
      }
    },
  };
}
