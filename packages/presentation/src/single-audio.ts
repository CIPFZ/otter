// Single audible tab (SPEC §15 外部窗口 / 多标签, ADR-008 §8): players of one origin share a
// BroadcastChannel; when one starts playing with sound, the others that are playing with sound
// mute themselves. The most recent start wins; nothing is restored when it pauses or its tab
// closes (the user unmutes where they want sound). Each yield is a QoE `audio-yield` event.
// A sub-entry (`@otter-player/presentation/single-audio`), not on the first screen.

import type { Plugin, PluginContext } from '@otter-player/core';

export interface SingleAudioOptions {
  /** BroadcastChannel name: players on the same channel share the sound. Default `otter-audio`. */
  readonly channel?: string;
}

/** The media state and action this uses (MediaState, MediaActionMap's `set-muted`). */
export interface SingleAudioState {
  readonly paused?: boolean | undefined;
  readonly muted?: boolean | undefined;
  readonly volume?: number | undefined;
}
export interface SingleAudioActionMap {
  'set-muted': { readonly muted: boolean };
}

interface Audible {
  readonly type: 'audible';
  readonly id: string;
  /** Wall-clock start (Date.now(): comparable across tabs); ties go to the larger id. */
  readonly at: number;
}

const audible = (s: SingleAudioState): boolean => s.paused === false && s.muted !== true && (s.volume ?? 1) > 0;

export function createSingleAudioPlugin<S extends SingleAudioState, A extends SingleAudioActionMap>(options: SingleAudioOptions = {}): Plugin<S, A> {
  let off: (() => void) | undefined;
  return {
    id: 'single-audio',
    install(ctx: PluginContext<S, A>) {
      if (typeof BroadcastChannel !== 'function') return;
      const store = ctx.store;
      const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      const channel = new BroadcastChannel(options.channel ?? 'otter-audio');
      /** When this player last started making sound (undefined: silent now). */
      let since: number | undefined;
      const update = (): void => {
        const now = audible(store.getState());
        if (now === (since !== undefined)) return;
        since = now ? Date.now() : undefined;
        if (since !== undefined) channel.postMessage({ type: 'audible', id, at: since } satisfies Audible);
      };
      channel.onmessage = (e: MessageEvent<Partial<Audible> | null>) => {
        const m = e.data;
        if (m?.type !== 'audible' || typeof m.id !== 'string' || typeof m.at !== 'number' || m.id === id) return;
        // Only a later start takes the sound (two tabs starting together: one of them keeps it).
        if (since === undefined || m.at < since || (m.at === since && m.id < id)) return;
        void store.dispatch('set-muted', { muted: true } as A['set-muted']);
        ctx.qoe.emit('audio-yield', { to: m.id });
      };
      const unsubscribe = store.subscribe(update);
      update();
      off = () => {
        unsubscribe();
        channel.close();
      };
    },
    uninstall() {
      off?.();
      off = undefined;
    },
  };
}
