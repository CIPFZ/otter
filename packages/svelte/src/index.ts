// Svelte bindings (SPEC §16, ADR-013 batch 3): an action that hosts a player made by any preset in
// an element, a store adapter over its state, and a component (`@otter-player/svelte/OtterPlayer.svelte`,
// shipped as source and compiled by the host's Svelte toolchain) built on the action. As the React and
// Vue bindings: the store only through getState / subscribe, no Otter runtime imported here, the host
// passes the preset. Plain TypeScript: no Svelte import (the store follows Svelte's store contract).
//
// Server rendering: actions run only in the browser, after hydration; the element they sit on is
// the server-rendered empty box. On a server Svelte subscribes to a store and unsubscribes at once:
// the adapter gives the current state and leaves no listener behind (no environment check: that
// would read `document`).

/** What the bindings need of a store: Otter's StoreView fits. */
export interface OtterStoreLike<S> {
  /** The state now. */
  getState(): S;
  /** The server snapshot (core's StoreView has it); getState() when missing. */
  getInitialState?(): S;
  /** Calls the listener after every change; returns its removal. */
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

/** What the action needs of a player: every preset's handle fits. */
export interface OtterPlayerLike {
  /** Tears the player down (called on unmount or when `deps` change). */
  destroy(): unknown;
}

/** Svelte's readable store contract (svelte/store `Readable`), without importing Svelte. */
export interface OtterReadable<T> {
  /**
   * Svelte's store contract: calls `run` with the value now and on every change; returns its
   * removal.
   */
  subscribe(run: (value: T) => void): () => void;
}

/**
 * A slice of the store's state as a Svelte store (`$paused`), changing only when the slice changes
 * (`equals`, default Object.is). `store` null / undefined (no player yet): undefined.
 */
export function otterState<S, T>(store: OtterStoreLike<S> | null | undefined, selector: (state: S) => T, equals: (a: T, b: T) => boolean = Object.is): OtterReadable<T | undefined> {
  return {
    subscribe(run) {
      if (store == null) {
        run(undefined);
        return () => undefined;
      }
      let value = selector(store.getState());
      run(value);
      return store.subscribe((state) => {
        const next = selector(state);
        if (equals(value, next)) return;
        value = next;
        run(value);
      });
    },
  };
}

/** What the otterPlayer action takes. */
export interface OtterPlayerActionOptions<P extends OtterPlayerLike> {
  /** Makes the player in the container it gets (a preset: `(container) => createVodPlayer({ container, ... })`). */
  readonly create: (container: HTMLElement) => P;
  /**
   * Remake the player when one of these changes (compared item by item).
   * @defaultValue `[]` (once)
   */
  readonly deps?: readonly unknown[];
  /**
   * Called with the player once made, and with null when it goes.
   * @defaultValue none
   */
  readonly onPlayer?: (player: P | null) => void;
}

/**
 * `use:otterPlayer={{ create, deps, onPlayer }}`: makes the player inside a fresh child of the
 * element, destroys it (and the child) when the element goes or when `deps` changes.
 * @example
 * ```svelte
 * <script>
 *   import { otterPlayer } from '@otter-player/svelte';
 *   import { createVodPlayer } from '@otter-player/presets/vod';
 *   import '@otter-player/ui-skin-default';
 *
 *   let { src } = $props();
 *   const create = (container) => {
 *     const player = createVodPlayer({ container, title: 'Example' });
 *     void player.load(src).catch((error) => {
 *       if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
 *     });
 *     return player;
 *   };
 * </script>
 *
 * <div style="aspect-ratio: 16 / 9" use:otterPlayer={{ create, deps: [src] }}></div>
 * ```
 */
export function otterPlayer<P extends OtterPlayerLike>(node: HTMLElement, options: OtterPlayerActionOptions<P>): { update(next: OtterPlayerActionOptions<P>): void; destroy(): void } {
  let current = options;
  let stop: (() => void) | undefined;
  const make = (): void => {
    stop?.();
    const container = node.ownerDocument.createElement('div');
    container.style.cssText = 'position:relative;width:100%;height:100%';
    node.append(container);
    const made = current.create(container);
    current.onPlayer?.(made);
    stop = () => {
      current.onPlayer?.(null);
      void Promise.resolve()
        .then(() => made.destroy())
        .catch(() => undefined)
        .finally(() => container.remove());
    };
  };
  make();
  return {
    update(next) {
      const before = current.deps ?? [];
      const after = next.deps ?? [];
      current = next;
      if (before.length !== after.length || before.some((d, i) => !Object.is(d, after[i]))) make();
    },
    destroy() {
      stop?.();
      stop = undefined;
    },
  };
}
