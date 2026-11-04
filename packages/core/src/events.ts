// Type-safe event bus (SPEC §4): no string-built event names, `once`, unsubscribe functions,
// and trigger chains for provenance (design borrowed from Vidstack triggers, L4).

export type Unsubscribe = () => void;

/** Origin chain of an event or action, e.g. `keydown` -> `toggle-paused` -> `play`. */
export interface Trigger {
  /** The event or action name (`keydown`, `toggle-paused`). */
  readonly type: string;
  /** What raised it (`otter-play-button`, a plugin id). */
  readonly source?: string;
  /** What caused this one, up the chain. */
  readonly parent?: Trigger;
}

/** What a handler gets besides the payload: the event type and, when known, the trigger chain. */
export interface EventMeta<K extends PropertyKey = PropertyKey> {
  /** The event type. */
  readonly type: K;
  /** What caused it (a key press, an action), when known. */
  readonly trigger?: Trigger;
}

export type EventHandler<P, K extends PropertyKey = PropertyKey> = (payload: P, meta: EventMeta<K>) => void;

/** A typed event bus: event names are the keys of M, payloads its values. */
export interface EventBus<M extends object> {
  /** Calls the handler on every `type` event; returns its unsubscribe. */
  on<K extends keyof M>(type: K, handler: EventHandler<M[K], K>): Unsubscribe;
  /** Calls the handler on the next `type` event only; returns its unsubscribe. */
  once<K extends keyof M>(type: K, handler: EventHandler<M[K], K>): Unsubscribe;
  /**
   * Delivers synchronously to every handler. Handler exceptions never stop delivery to the
   * others; they are rethrown after delivery (AggregateError when more than one).
   */
  emit<K extends keyof M>(type: K, payload: M[K], trigger?: Trigger): void;
  /** Removes every handler. */
  clear(): void;
}

type AnyHandler = (payload: unknown, meta: EventMeta) => void;

/**
 * Creates a typed event bus (a plugin's own events; the core's and the QoE hook are made with it).
 */
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
