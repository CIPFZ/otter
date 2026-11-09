// Plugin registry (SPEC §4): `Plugin { id, deps?, install(ctx), uninstall() }`, installed in
// dependency (topological) order. Every format, backend, ABR, DRM, decoder, renderer, text track
// and UI feature is attached through this interface; core never imports an implementation.

import { createError, type OtterError } from './errors.js';
import type { EventBus } from './events.js';
import type { QoeHook } from './qoe.js';
import type { Store } from './store.js';

/** The core's events: errors and the plugin lifecycle. */
export interface CoreEventMap {
  /** An error from any part of the player (fatal or not), including ones a retry or fallback then recovers from. */
  error: OtterError;
  /** A plugin finished installing. */
  'plugin-installed': { readonly id: string };
  /** A plugin finished uninstalling. */
  'plugin-uninstalled': { readonly id: string };
}

/** What a plugin gets at install: the store, the event bus and the QoE hook. */
export interface PluginContext<S extends object = object, A extends object = object> {
  /** State and actions (a plugin registers its action handlers here). */
  readonly store: Store<S, A>;
  /** Errors and plugin lifecycle events. */
  readonly events: EventBus<CoreEventMap>;
  /** QoE events. */
  readonly qoe: QoeHook;
}

/**
 * A plugin: everything a player is made of (formats, backends, UI features, overlays) attaches
 * through this.
 */
export interface Plugin<S extends object = object, A extends object = object> {
  /** Unique id in the registry. */
  readonly id: string;
  /** Ids of plugins that must be installed first. */
  readonly deps?: readonly string[];
  /** Sets the plugin up (action handlers, subscriptions); may be async. */
  install(ctx: PluginContext<S, A>): void | Promise<void>;
  /** Undoes install(). */
  uninstall(): void | Promise<void>;
}

/** The plugins of a core, installed in dependency order. */
export interface PluginRegistry<S extends object = object, A extends object = object> {
  /** Adds a plugin; a duplicate id throws `pluginDuplicate`. */
  register(plugin: Plugin<S, A>): void;
  /** Whether a plugin with this id is registered. */
  has(id: string): boolean;
  /** Deterministic topological order; ties keep registration order. */
  order(): readonly Plugin<S, A>[];
  /** Installs in order. On failure, already-installed plugins are uninstalled in reverse. */
  installAll(ctx: PluginContext<S, A>): Promise<void>;
  /** Uninstalls in reverse order; every plugin is attempted, failures are rethrown afterwards. */
  uninstallAll(): Promise<void>;
}

const pluginError = (details: string, message: string, cause?: unknown): OtterError & Error =>
  createError({
    type: 'other',
    details,
    fatal: true,
    recoverable: false,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

/** Creates a plugin registry (createCore makes one; a host rarely needs its own). */
export function createPluginRegistry<S extends object = object, A extends object = object>(): PluginRegistry<S, A> {
  const plugins = new Map<string, Plugin<S, A>>();
  let installed: Plugin<S, A>[] = [];
  let context: PluginContext<S, A> | undefined;
  let generation = 0;
  let pending: Promise<void> | undefined;
  const serialize = (run: () => Promise<void>): Promise<void> => {
    const previous = pending;
    let finish: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    // Register before calling a plugin: install itself may synchronously request teardown.
    pending = settled;
    const task = previous === undefined ? run() : previous.then(run);
    void task.then(finish, finish);
    void settled.then(() => {
      if (pending === settled) pending = undefined;
    });
    return task;
  };

  const order = (): Plugin<S, A>[] => {
    const result: Plugin<S, A>[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (p: Plugin<S, A>, path: readonly string[]): void => {
      const s = state.get(p.id);
      if (s === 'done') return;
      if (s === 'visiting') {
        throw pluginError('pluginDependencyCycle', `plugin dependency cycle: ${[...path, p.id].join(' -> ')}`);
      }
      state.set(p.id, 'visiting');
      for (const depId of p.deps ?? []) {
        const dep = plugins.get(depId);
        if (dep === undefined) {
          throw pluginError('pluginMissingDependency', `plugin "${p.id}" depends on unregistered "${depId}"`);
        }
        visit(dep, [...path, p.id]);
      }
      state.set(p.id, 'done');
      result.push(p);
    };
    for (const p of plugins.values()) visit(p, []);
    return result;
  };

  const uninstallInstalled = async (): Promise<unknown[]> => {
    const errors: unknown[] = [];
    while (installed.length > 0) {
      const p = installed.pop();
      if (p === undefined) break;
      try {
        await p.uninstall();
        context?.events.emit('plugin-uninstalled', { id: p.id });
      } catch (err) {
        errors.push(err);
      }
    }
    return errors;
  };

  return {
    register(plugin) {
      if (plugins.has(plugin.id)) {
        throw pluginError('pluginDuplicate', `plugin "${plugin.id}" is already registered`);
      }
      plugins.set(plugin.id, plugin);
    },
    has: (id) => plugins.has(id),
    order,
    installAll(ctx) {
      const requested = generation;
      return serialize(async () => {
        context = ctx;
        for (const p of order()) {
          if (requested !== generation) return;
          if (installed.includes(p)) continue;
          try {
            await p.install(ctx);
          } catch (err) {
            const rollback = await uninstallInstalled();
            const cause = rollback.length === 0 ? err : new AggregateError([err, ...rollback]);
            throw pluginError('pluginInstallFailed', `plugin "${p.id}" failed to install`, cause);
          }
          // A concurrent uninstall waits for this installation, then releases it.
          installed.push(p);
          if (requested === generation) ctx.events.emit('plugin-installed', { id: p.id });
        }
      });
    },
    uninstallAll() {
      generation++;
      return serialize(async () => {
        const errors = await uninstallInstalled();
        installed = [];
        if (errors.length > 0) {
          throw pluginError('pluginUninstallFailed', 'one or more plugins failed to uninstall', new AggregateError(errors));
        }
      });
    },
  };
}
