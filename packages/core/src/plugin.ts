// Plugin registry (SPEC §4): `Plugin { id, deps?, install(ctx), uninstall() }`, installed in
// dependency (topological) order. Every format, backend, ABR, DRM, decoder, renderer, text track
// and UI feature is attached through this interface; core never imports an implementation.

import { createError, type OtterError } from './errors';
import type { EventBus } from './events';
import type { QoeHook } from './qoe';
import type { Store } from './store';

export interface CoreEventMap {
  error: OtterError;
  'plugin-installed': { readonly id: string };
  'plugin-uninstalled': { readonly id: string };
}

export interface PluginContext<S extends object = object, A extends object = object> {
  readonly store: Store<S, A>;
  readonly events: EventBus<CoreEventMap>;
  readonly qoe: QoeHook;
}

export interface Plugin<S extends object = object, A extends object = object> {
  readonly id: string;
  /** Ids of plugins that must be installed first. */
  readonly deps?: readonly string[];
  install(ctx: PluginContext<S, A>): void | Promise<void>;
  uninstall(): void | Promise<void>;
}

export interface PluginRegistry<S extends object = object, A extends object = object> {
  register(plugin: Plugin<S, A>): void;
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

export function createPluginRegistry<S extends object = object, A extends object = object>(): PluginRegistry<S, A> {
  const plugins = new Map<string, Plugin<S, A>>();
  let installed: Plugin<S, A>[] = [];
  let context: PluginContext<S, A> | undefined;

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
    async installAll(ctx) {
      context = ctx;
      for (const p of order()) {
        if (installed.includes(p)) continue;
        try {
          await p.install(ctx);
        } catch (err) {
          const rollback = await uninstallInstalled();
          const cause = rollback.length === 0 ? err : new AggregateError([err, ...rollback]);
          throw pluginError('pluginInstallFailed', `plugin "${p.id}" failed to install`, cause);
        }
        installed.push(p);
        ctx.events.emit('plugin-installed', { id: p.id });
      }
    },
    async uninstallAll() {
      const errors = await uninstallInstalled();
      installed = [];
      if (errors.length > 0) {
        throw pluginError('pluginUninstallFailed', 'one or more plugins failed to uninstall', new AggregateError(errors));
      }
    },
  };
}
