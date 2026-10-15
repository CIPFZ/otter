// Reactive store (SPEC §4). Zustand-style slices composed from a `features` list, same shape as
// the video.js v10 store (REUSE §4 row 1: L4 self-written while v10 is RC, see SPEC Q2).
//
// Layering rule (SPEC §3): UI / Overlay / Presentation only ever receive a StoreView, which can
// read state and dispatch actions but cannot write state. Engine-side code owns the full Store.
//
// dispatch() is synchronous end to end, so an action raised inside a user-gesture callback reaches
// its handler in the same call stack (fullscreen / PiP / orientation lock / unmuted autoplay).

import { createError } from './errors';
import type { Trigger, Unsubscribe } from './events';

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
}

export interface StoreOptions {
  readonly slices: readonly StoreSlice[];
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
    for (const listener of [...listeners]) listener(state, prev);
  };

  const subscribe = (listener: StateListener<S>): Unsubscribe => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const view: StoreView<S, A> = {
    getState,
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
  };
}
