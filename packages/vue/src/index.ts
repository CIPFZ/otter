// Vue bindings (SPEC §16, ADR-013 batch 3): a component that hosts a player made by any preset,
// and composables that read its store. As the React bindings: the store only through getState /
// subscribe (the host dispatches through it), no Otter runtime imported here, the host passes the
// preset.
//
// Server rendering: nothing here touches window, document or AudioContext in setup or render. The
// component renders an empty box (aspect ratio, poster) on the server and on the first client
// render alike, so hydration matches; the player is made in onMounted, i.e. only in the browser,
// inside a fresh child of that box (and removed with it). The composables read the store's
// initial state on the server and subscribe only once mounted.

import { h, onBeforeUnmount, onMounted, ref, shallowRef, watch, type CSSProperties, type DefineSetupFnComponent, type Ref, type SetupContext, type ShallowRef, type VNode } from 'vue';

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

type StoreSource<S> = OtterStoreLike<S> | null | undefined | Readonly<Ref<OtterStoreLike<S> | null | undefined>> | (() => OtterStoreLike<S> | null | undefined);

const read = <S>(source: StoreSource<S>): OtterStoreLike<S> | null | undefined =>
  typeof source === 'function' ? source() : source !== null && source !== undefined && 'value' in source ? source.value : (source as OtterStoreLike<S> | null | undefined);

/**
 * A slice of the store's state as a ref, updated only when it changes (`equals`, default
 * Object.is). `store` may be a store, a ref to one or a getter; null / undefined (no player yet,
 * on the server): the ref holds undefined.
 */
export function useOtterState<S, T>(store: StoreSource<S>, selector: (state: S) => T, equals: (a: T, b: T) => boolean = Object.is): Readonly<ShallowRef<T | undefined>> {
  const initial = read(store);
  const value = shallowRef<T | undefined>(initial == null ? undefined : selector((initial.getInitialState ?? initial.getState).call(initial)));
  let off: (() => void) | undefined;
  const follow = (s: OtterStoreLike<S> | null | undefined): void => {
    off?.();
    off = undefined;
    if (s == null) {
      value.value = undefined;
      return;
    }
    const take = (state: S): void => {
      const next = selector(state);
      if (value.value === undefined || !equals(value.value, next)) value.value = next;
    };
    take(s.getState());
    off = s.subscribe((state) => take(state));
  };
  // Subscribed only in the browser (onMounted does not run on a server).
  onMounted(() => {
    follow(read(store));
    watch(() => read(store), follow);
  });
  onBeforeUnmount(() => {
    off?.();
    off = undefined;
  });
  return value;
}

/** What useOtterPlayer returns: the template ref for the box and the player. */
export interface UseOtterPlayer<P> {
  /** The box's template ref: the player is made inside it once mounted. */
  readonly box: Ref<HTMLElement | null>;
  /** The player, from mount on (null on the server and before mount). */
  readonly player: Readonly<ShallowRef<P | null>>;
}

/**
 * Makes a player with `create` inside the element bound to `box`, once mounted, and destroys it on
 * unmount or when `deps` changes. `create` gets an empty container (the preset builds its controls
 * inside), a child of that element.
 */
export function useOtterPlayer<P extends OtterPlayerLike>(create: () => (container: HTMLElement) => P, deps: () => readonly unknown[] = () => []): UseOtterPlayer<P> {
  const box = ref<HTMLElement | null>(null);
  // A shallow ref holds the player as it is (no deep reactivity over a player's internals).
  const player = shallowRef(null) as ShallowRef<P | null>;
  let stop: (() => void) | undefined;
  const make = (): void => {
    stop?.();
    const el = box.value;
    if (el === null) return;
    const container = el.ownerDocument.createElement('div');
    container.style.cssText = 'position:relative;width:100%;height:100%';
    el.append(container);
    const made = create()(container);
    player.value = made;
    stop = () => {
      player.value = null;
      void Promise.resolve()
        .then(() => made.destroy())
        .catch(() => undefined)
        .finally(() => container.remove());
    };
  };
  onMounted(() => {
    make();
    watch(deps, make);
  });
  onBeforeUnmount(() => {
    stop?.();
    stop = undefined;
  });
  return { box, player };
}

/** Props of the Vue OtterPlayer component. */
export interface OtterPlayerProps {
  /** Makes the player in the container it gets (a preset: `(container) => createVodPlayer({ container, ... })`). */
  readonly create: (container: HTMLElement) => OtterPlayerLike;
  /**
   * Remake the player when one of these changes.
   * @defaultValue `[]` (once per mount)
   */
  readonly deps?: readonly unknown[];
  /**
   * Reserved box before the player exists (no layout shift): CSS aspect-ratio.
   * @defaultValue `'16 / 9'`
   */
  readonly aspectRatio?: string;
  /**
   * Picture shown in the box until the player's own poster or first frame covers it.
   * @defaultValue none
   */
  readonly poster?: string;
}

type OtterPlayerEmits = { player: (p: OtterPlayerLike | null) => true };

/**
 * A player made by a preset, as a component. Server-rendered as the empty box (same markup on the
 * client's first render); the player is made after mount. Emits `player` with it, and with null
 * when it goes.
 * @example
 * ```ts
 * import { defineComponent, h } from 'vue';
 * import { OtterPlayer } from '@otter-player/vue';
 * import { createVodPlayer } from '@otter-player/presets/vod';
 * import '@otter-player/ui-skin-default';
 *
 * export const Video = defineComponent({
 *   props: { src: { type: String, required: true } },
 *   setup(props) {
 *     const create = (container: HTMLElement) => {
 *       const player = createVodPlayer({ container, title: 'Example' });
 *       void player.load(props.src);
 *       return player;
 *     };
 *     return () => h(OtterPlayer, { create, deps: [props.src] });
 *   },
 * });
 * ```
 */
// A component options object, not a defineComponent() call: nothing runs at import (the
// side-effect gate counts top-level calls; defineComponent only types an object like this one).
export const OtterPlayer: DefineSetupFnComponent<OtterPlayerProps, OtterPlayerEmits> = {
  name: 'OtterPlayer',
  props: ['create', 'deps', 'aspectRatio', 'poster'],
  emits: ['player'],
  setup(props: OtterPlayerProps, { emit }: SetupContext<OtterPlayerEmits>) {
    const { box, player } = useOtterPlayer(
      () => props.create,
      () => props.deps ?? [],
    );
    watch(player, (p) => emit('player', p));
    return (): VNode => {
      const style: CSSProperties = {
        position: 'relative',
        aspectRatio: props.aspectRatio ?? '16 / 9',
        ...(props.poster === undefined ? {} : { backgroundImage: `url(${JSON.stringify(props.poster)})`, backgroundSize: 'cover', backgroundPosition: 'center' }),
      };
      return h('div', { ref: box, 'data-otter-vue': '', style });
    };
  },
} as unknown as DefineSetupFnComponent<OtterPlayerProps, OtterPlayerEmits>;
