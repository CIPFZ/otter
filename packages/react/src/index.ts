// React bindings (SPEC §16, ADR-013 batch 3): a component that hosts a player made by any preset,
// and a hook that reads its store. They use the store only through getState / subscribe (and the
// host dispatches through it): no Otter runtime is imported here, the host passes the preset.
//
// Server rendering: nothing here touches window, document or AudioContext while rendering. The
// component renders an empty box (aspect ratio, poster) on the server and on the first client
// render alike, so hydration matches; the player is made in an effect, i.e. only in the browser,
// inside a fresh child of that box (and removed with it: Strict Mode's mount / unmount / mount
// gets two independent players, not one built twice into the same markup).

import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react';

/** What the bindings need of a store: Otter's StoreView fits. */
export interface OtterStoreLike<S> {
  getState(): S;
  /** The server snapshot (core's StoreView has it); getState() when missing. */
  getInitialState?(): S;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

/** What the component needs of a player: every preset's handle fits. */
export interface OtterPlayerLike {
  destroy(): unknown;
}

/**
 * A slice of the store's state, re-rendering only when it changes (`equals`, default Object.is).
 * `store` may be null or undefined (no player yet, on the server): the hook returns undefined.
 */
export function useOtterState<S, T>(store: OtterStoreLike<S> | null | undefined, selector: (state: S) => T, equals: (a: T, b: T) => boolean = Object.is): T | undefined {
  // The last state seen and what the selector made of it: the same value until the slice changes
  // (useSyncExternalStore requires a stable snapshot).
  const memo = useRef<{ store: OtterStoreLike<S>; state: S; value: T } | undefined>(undefined);
  const select = (s: OtterStoreLike<S>, state: S): T => {
    const m = memo.current;
    if (m !== undefined && m.store === s && m.state === state) return m.value;
    const next = selector(state);
    const value = m !== undefined && m.store === s && equals(m.value, next) ? m.value : next;
    memo.current = { store: s, state, value };
    return value;
  };
  const subscribe = useCallback((onChange: () => void): (() => void) => (store == null ? () => undefined : store.subscribe(onChange)), [store]);
  return useSyncExternalStore(
    subscribe,
    () => (store == null ? undefined : select(store, store.getState())),
    () => (store == null ? undefined : select(store, (store.getInitialState ?? store.getState).call(store))),
  );
}

export interface UseOtterPlayer<P> {
  /** The box's ref: the player is made inside it once it is in the document. */
  readonly ref: (box: HTMLElement | null) => void;
  /** The player, from the first effect on (null on the server and in the first render). */
  readonly player: P | null;
}

/**
 * Makes a player with `create` inside the element given to `ref`, after mount, and destroys it on
 * unmount or when a dependency changes. `create` gets an empty container (the preset builds its
 * controls inside), a child of that element.
 */
export function useOtterPlayer<P extends OtterPlayerLike>(create: (container: HTMLElement) => P, deps: readonly unknown[] = []): UseOtterPlayer<P> {
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [player, setPlayer] = useState<P | null>(null);
  const latest = useRef(create);
  latest.current = create;
  useEffect(() => {
    if (box === null) return undefined;
    const container = box.ownerDocument.createElement('div');
    container.style.cssText = 'position:relative;width:100%;height:100%';
    box.append(container);
    const made = latest.current(container);
    setPlayer(made);
    return () => {
      setPlayer(null);
      void Promise.resolve()
        .then(() => made.destroy())
        .catch(() => undefined)
        .finally(() => container.remove());
    };
    // The host's deps decide when to remake (not `create`, a new function every render).
  }, [box, ...deps]);
  return { ref: setBox, player };
}

export interface OtterPlayerProps<P extends OtterPlayerLike> {
  /** Makes the player in the container it gets (a preset: `(container) => createVodPlayer({ container, ... })`). */
  readonly create: (container: HTMLElement) => P;
  /** Remake the player when one of these changes (default: once per mount). */
  readonly deps?: readonly unknown[];
  /** Called with the player once made, and with null when it goes. */
  readonly onPlayer?: (player: P | null) => void;
  /** Reserved box before the player exists (no layout shift): CSS aspect-ratio, default `16 / 9`. */
  readonly aspectRatio?: string;
  /** Picture shown in the box until the player's own poster / first frame covers it. */
  readonly poster?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly id?: string;
}

/**
 * A player made by a preset, as a component. Server-rendered as the empty box (same markup on the
 * client's first render); the player is made after hydration.
 */
export function OtterPlayer<P extends OtterPlayerLike>(props: OtterPlayerProps<P>): ReactElement {
  const { ref, player } = useOtterPlayer(props.create, props.deps);
  const onPlayer = useRef(props.onPlayer);
  onPlayer.current = props.onPlayer;
  useEffect(() => {
    onPlayer.current?.(player);
  }, [player]);
  const style: CSSProperties = {
    position: 'relative',
    aspectRatio: props.aspectRatio ?? '16 / 9',
    ...(props.poster === undefined ? {} : { backgroundImage: `url(${JSON.stringify(props.poster)})`, backgroundSize: 'cover', backgroundPosition: 'center' }),
    ...props.style,
  };
  return createElement('div', {
    ref,
    'data-otter-react': '',
    style,
    ...(props.className === undefined ? {} : { className: props.className }),
    ...(props.id === undefined ? {} : { id: props.id }),
  });
}
