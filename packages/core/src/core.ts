// Core assembly: the host passes slices (from `features`) and plugins, listens to events and
// dispatches actions (SPEC §16 host contract).

import { createError } from './errors.js';
import { createEventBus, type EventBus } from './events.js';
import { createPluginRegistry, type CoreEventMap, type Plugin, type PluginRegistry } from './plugin.js';
import { createQoeHook, type QoeHook } from './qoe.js';
import { createStore, type Store, type StoreSlice } from './store.js';

/** What createCore starts with: the state slices and the plugins. */
export interface CoreOptions<S extends object, A extends object> {
  /**
   * The store's slices: each declares its keys and initial state.
   * @defaultValue `[]`
   */
  readonly slices?: readonly StoreSlice[];
  /**
   * Plugins to register (installed by start(), in dependency order).
   * @defaultValue `[]`
   */
  readonly plugins?: readonly Plugin<S, A>[];
}

/** The host contract (SPEC §16): a store, the event bus, the QoE hook and the plugin registry. */
export interface OtterCore<S extends object, A extends object> {
  /** State and actions. */
  readonly store: Store<S, A>;
  /** Errors and plugin lifecycle events. */
  readonly events: EventBus<CoreEventMap>;
  /** QoE events. */
  readonly qoe: QoeHook;
  /** The plugins: register before start(). */
  readonly plugins: PluginRegistry<S, A>;
  /** Installs every registered plugin in dependency order. */
  start(): Promise<void>;
  /** Uninstalls every plugin, then clears the buses and the store. */
  destroy(): Promise<void>;
}

/**
 * Creates the core a player is built on (createPlayer and the presets call it): the store with its
 * slices, the buses, the plugin registry. A state listener that throws becomes a non-fatal
 * `storeListenerError` event.
 */
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
