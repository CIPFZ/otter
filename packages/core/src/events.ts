// Type-safe event bus (SPEC §4): no string-built event names, `once`, unsubscribe functions,
// and trigger chains for provenance (design borrowed from Vidstack triggers, L4).

export type Unsubscribe = () => void;

/** Origin chain of an event or action, e.g. `keydown` -> `toggle-paused` -> `play`. */
export interface Trigger {
  readonly type: string;
  readonly source?: string;
  readonly parent?: Trigger;
}

export interface EventMeta<K extends PropertyKey = PropertyKey> {
  readonly type: K;
  readonly trigger?: Trigger;
}

export type EventHandler<P, K extends PropertyKey = PropertyKey> = (payload: P, meta: EventMeta<K>) => void;

export interface EventBus<M extends object> {
  on<K extends keyof M>(type: K, handler: EventHandler<M[K], K>): Unsubscribe;
  once<K extends keyof M>(type: K, handler: EventHandler<M[K], K>): Unsubscribe;
  /**
   * Delivers synchronously to every handler. Handler exceptions never stop delivery to the
   * others; they are rethrown after delivery (AggregateError when more than one).
   */
  emit<K extends keyof M>(type: K, payload: M[K], trigger?: Trigger): void;
  clear(): void;
}

type AnyHandler = (payload: unknown, meta: EventMeta) => void;

export function createEventBus<M extends object>(): EventBus<M> {
  const handlers = new Map<keyof M, Set<AnyHandler>>();

  const on = <K extends keyof M>(type: K, handler: EventHandler<M[K], K>): Unsubscribe => {
    let set = handlers.get(type);
    if (set === undefined) {
      set = new Set();
      handlers.set(type, set);
    }
    const h = handler as AnyHandler;
    set.add(h);
    return () => {
      set.delete(h);
    };
  };

  return {
    on,
    once(type, handler) {
      const off = on(type, (payload, meta) => {
        off();
        handler(payload, meta);
      });
      return off;
    },
    emit(type, payload, trigger) {
      const set = handlers.get(type);
      if (set === undefined || set.size === 0) return;
      const meta: EventMeta = trigger === undefined ? { type } : { type, trigger };
      const errors: unknown[] = [];
      // Snapshot so handlers may unsubscribe (or subscribe) during delivery.
      for (const h of [...set]) {
        try {
          h(payload, meta);
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, `${String(type)} handlers failed`);
    },
    clear() {
      handlers.clear();
    },
  };
}
