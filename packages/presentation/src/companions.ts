// Presentation companions (ADR-007 §5), loaded by the plugin at install: they matter once media
// plays, not for the first screen. Auto mini window; WakeLock while playing and visible;
// MediaSession metadata, handlers and position; casting (remote.ts).

import type { Store, Unsubscribe } from '@otter-player/core';
import type { PresentationController } from './controller.js';
import type { PresentationActionMap, PresentationState } from './plugin.js';

export { createRemoteControl } from './remote.js';

/** The media actions MediaSession handlers dispatch (structurally MediaActionMap's). */
export interface MediaSessionActions {
  play: undefined;
  pause: undefined;
  seek: { readonly time: number };
  'seek-by': { readonly seconds: number };
}
interface MediaFields {
  readonly paused?: boolean;
  readonly currentTime?: number;
  readonly duration?: number;
  readonly playbackRate?: number;
}

/**
 * Page mini window (SPEC §15): scrolled out of view while playing -> corner window; scrolled back
 * -> inline. Closing it by hand keeps it closed until the player is in view again; a mini window
 * opened by hand (toggle-mini) is left alone.
 */
export function autoMini(c: PresentationController, container: HTMLElement, video: HTMLVideoElement | undefined): Unsubscribe {
  let visible = true;
  let dismissed = false;
  let auto = false;
  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) dismissed = false;
    if (!visible && c.mode === 'inline' && !dismissed && video?.paused === false) {
      auto = true;
      void c.request('mini').then((m) => (auto = m === 'mini'));
    } else if (visible && c.mode === 'mini' && auto) void c.exit();
  });
  // In the mini window the placeholder holds the player's place in the page.
  const watch = (): void => {
    io.disconnect();
    const p = c.mode === 'mini' ? container.previousElementSibling : null;
    io.observe(p?.hasAttribute('data-otter-placeholder') === true ? p : container);
  };
  const off = c.on('change', ({ from, to }) => {
    if (from === 'mini' && to === 'inline' && !visible) dismissed = true;
    if (from === 'mini') auto = false;
    watch();
  });
  watch();
  return () => {
    off();
    io.disconnect();
  };
}

/** Screen WakeLock while playing and the page is visible; released on pause or hide. */
export function holdWakeLock<S extends PresentationState>(store: Store<S, PresentationActionMap>, doc: Document): Unsubscribe {
  const api = (navigator as Partial<Navigator>).wakeLock;
  if (api === undefined) return () => undefined;
  let lock: WakeLockSentinel | undefined;
  let requesting = false;
  const want = (): boolean => (store.getState() as MediaFields).paused === false && doc.visibilityState === 'visible';
  const update = (): void => {
    if (want() && lock === undefined && !requesting) {
      requesting = true;
      api.request('screen').then(
        (s) => {
          requesting = false;
          if (!want()) return void s.release();
          lock = s;
          store.setState({ wakeLocked: true } as Partial<S>);
          s.addEventListener('release', () => {
            if (lock !== s) return;
            lock = undefined;
            store.setState({ wakeLocked: false } as Partial<S>);
          });
        },
        () => (requesting = false),
      );
    } else if (!want() && lock !== undefined) {
      void lock.release();
    }
  };
  const off = store.subscribe((s, prev) => {
    if ((s as MediaFields).paused !== (prev as MediaFields).paused) update();
  });
  doc.addEventListener('visibilitychange', update);
  update();
  return () => {
    off();
    doc.removeEventListener('visibilitychange', update);
    void lock?.release();
  };
}

/** MediaSession: metadata, play / pause / seek handlers (dispatched to the store), position. */
export function bindMediaSession<S extends object>(store: Store<S, MediaSessionActions>, metadata: MediaMetadataInit | undefined): Unsubscribe {
  const ms = (navigator as Partial<Navigator>).mediaSession;
  if (ms === undefined) return () => undefined;
  if (metadata !== undefined && typeof MediaMetadata === 'function') ms.metadata = new MediaMetadata(metadata);
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => void store.dispatch('play', undefined)],
    ['pause', () => void store.dispatch('pause', undefined)],
    ['seekbackward', (d) => void store.dispatch('seek-by', { seconds: -(d.seekOffset ?? 10) })],
    ['seekforward', (d) => void store.dispatch('seek-by', { seconds: d.seekOffset ?? 10 })],
    ['seekto', (d) => void store.dispatch('seek', { time: d.seekTime ?? 0 })],
  ];
  const bind = (on: boolean): void => {
    for (const [action, fn] of handlers) {
      try {
        ms.setActionHandler(action, on ? fn : null);
      } catch {
        // Action not supported by this browser.
      }
    }
  };
  bind(true);
  let lastPosition = 0;
  const off = store.subscribe((st) => {
    const s = st as MediaFields;
    ms.playbackState = s.paused === false ? 'playing' : 'paused';
    const now = Date.now();
    if (now - lastPosition < 1000 || !(Number.isFinite(s.duration) && (s.duration ?? 0) > 0)) return;
    lastPosition = now;
    try {
      ms.setPositionState({ duration: s.duration as number, position: Math.min(s.currentTime ?? 0, s.duration as number), playbackRate: s.playbackRate || 1 });
    } catch {
      // Inconsistent values mid-seek; the next update corrects it.
    }
  });
  return () => {
    off();
    bind(false);
    ms.playbackState = 'none';
  };
}
