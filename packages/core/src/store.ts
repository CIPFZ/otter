// Reactive store (SPEC §4). Zustand-style slices composed from a `features` list, same shape as
// the video.js v10 store (REUSE §4 row 1: L4 self-written while v10 is RC, see SPEC Q2).
//
// Layering rule (SPEC §3): UI / Overlay / Presentation only ever receive a StoreView, which can
// read state and dispatch actions but cannot write state. Engine-side code owns the full Store.
//
// dispatch() is synchronous end to end, so an action raised inside a user-gesture callback reaches
// its handler in the same call stack (fullscreen / PiP / orientation lock / unmuted autoplay).

import { createError } from './errors.js';
import type { Trigger, Unsubscribe } from './events.js';

export interface StoreSlice<S extends object = object> {
  readonly id: string;
  readonly initialState: Readonly<S>;
}

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void
  ? I
  : never;
type SliceStateOf<T> = T extends StoreSlice<infer S> ? S : never;

/** Merged state type of a slice list: `SlicesState<typeof slices>`. */
export type SlicesState<T extends readonly StoreSlice[]> = UnionToIntersection<SliceStateOf<T[number]>>;

export type StateListener<S extends object> = (state: Readonly<S>, prev: Readonly<S>) => void;

export interface ActionContext<S extends object> {
  getState(): Readonly<S>;
  setState(patch: Partial<S>): void;
  readonly trigger?: Trigger;
}

export type ActionHandler<S extends object, P> = (payload: P, ctx: ActionContext<S>) => void;

/** Read-only view for UI, Overlay and Presentation layers. */
export interface StoreView<S extends object, A extends object> {
  getState(): Readonly<S>;
  /**
   * The state the slices start with, the same object every call: the server snapshot for SSR and
   * hydration (React useSyncExternalStore's getServerSnapshot), equal to getState() until the
   * first change.
   */
  getInitialState(): Readonly<S>;
  subscribe(listener: StateListener<S>): Unsubscribe;
  select<T>(
    selector: (state: Readonly<S>) => T,
    listener: (value: T, prev: T) => void,
    equals?: (a: T, b: T) => boolean,
  ): Unsubscribe;
  /** Runs handlers synchronously. Returns false when no handler is registered for `type`. */
  dispatch<K extends keyof A>(type: K, payload: A[K], trigger?: Trigger): boolean;
}

/** Full store, owned by core and engine-side plugins. */
export interface Store<S extends object, A extends object> extends StoreView<S, A> {
  setState(patch: Partial<S>): void;
  handle<K extends keyof A>(type: K, handler: ActionHandler<S, A[K]>): Unsubscribe;
  view(): StoreView<S, A>;
  /** Drops every listener and handler (the player is gone; a framework binding's subscription too). */
  destroy(): void;
}

export interface StoreOptions {
  readonly slices: readonly StoreSlice[];
  /**
   * A listener threw. The state change stands and every other listener still runs; the error goes
   * here (createCore: an `error` event), by default rethrown in a microtask (never swallowed, but
   * not into the engine code that called setState).
   */
  readonly onListenerError?: (error: unknown) => void;
}

type AnyActionHandler<S extends object> = ActionHandler<S, unknown>;

export function createStore<S extends object, A extends object = Record<never, never>>(
  options: StoreOptions,
): Store<S, A> {
  const initial: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const slice of options.slices) {
    for (const key of Object.keys(slice.initialState)) {
      const prevOwner = owner.get(key);
      if (prevOwner !== undefined) {
        throw createError({
          type: 'other',
          details: 'storeSliceConflict',
          fatal: true,
          recoverable: false,
          message: `state key "${key}" is declared by both "${prevOwner}" and "${slice.id}"`,
        });
      }
      owner.set(key, slice.id);
      initial[key] = (slice.initialState as Record<string, unknown>)[key];
    }
  }

  let state = Object.freeze(initial) as Readonly<S>;
  const initialState = state;
  // queueMicrotask is in every browser and Node, but not in the ES lib core compiles against.
  const onError =
    options.onListenerError ??
    ((e: unknown) =>
      (globalThis as { queueMicrotask?: (task: () => void) => void }).queueMicrotask?.(() => {
        throw e;
      }));
  const listeners = new Set<StateListener<S>>();
  const handlers = new Map<keyof A, Set<AnyActionHandler<S>>>();

  const getState = (): Readonly<S> => state;

  const setState = (patch: Partial<S>): void => {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof S)[]) {
      if (!Object.is(state[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const prev = state;
    state = Object.freeze({ ...prev, ...patch });
    for (const listener of [...listeners]) {
      try {
        listener(state, prev);
      } catch (e) {
        onError(e);
      }
    }
  };

  const subscribe = (listener: StateListener<S>): Unsubscribe => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const view: StoreView<S, A> = {
    getState,
    getInitialState: () => initialState,
    subscribe,
    select(selector, listener, equals = Object.is) {
      let current = selector(state);
      return subscribe((next) => {
        const value = selector(next);
        if (equals(value, current)) return;
        const prev = current;
        current = value;
        listener(value, prev);
      });
    },
    dispatch(type, payload, trigger) {
      const set = handlers.get(type);
      if (set === undefined || set.size === 0) return false;
      const ctx: ActionContext<S> = trigger === undefined ? { getState, setState } : { getState, setState, trigger };
      for (const h of [...set]) h(payload, ctx);
      return true;
    },
  };

  return {
    ...view,
    setState,
    handle(type, handler) {
      let set = handlers.get(type);
      if (set === undefined) {
        set = new Set();
        handlers.set(type, set);
      }
      const h = handler as AnyActionHandler<S>;
      set.add(h);
      return () => {
        set.delete(h);
      };
    },
    view: () => view,
    destroy() {
      listeners.clear();
      handlers.clear();
    },
  };
}
