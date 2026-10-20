// PresentationController (SPEC §15, ADR-007 §5): window-mode state machine. Every transition is
// request -> async browser result -> confirm or roll back; nothing is applied optimistically, and a
// refusal emits `denied` with a reason.
//
// User activation: the browser API (requestFullscreen, requestPictureInPicture,
// documentPictureInPicture.requestWindow, webkitEnterFullscreen) is called synchronously inside
// request(), before the first await, so the gesture that dispatched it is not lost.
//
// Capabilities come from feature detection only (no UA sniffing): an iPhone has no element
// fullscreen, so `fullscreen` reports `emulated` there and the controller uses pseudo-fullscreen.
// Only the unprefixed Fullscreen / PiP APIs are used (Safari 16.4+ / 13.1+, RESEARCH §1); older
// engines get pseudo-fullscreen and no PiP. iPhone's `webkitEnterFullscreen` is the exception.

import { createEventBus, type Unsubscribe } from '@otter-player/core';
import type { Surface } from '@otter-player/surface';

export type PresentationMode = 'inline' | 'theater' | 'fullscreen' | 'pip' | 'docpip' | 'mini' | 'background';

export type PresentationSupport = 'native' | 'emulated' | false;

export type PresentationCapabilities = Readonly<Record<PresentationMode, PresentationSupport>>;

/** Why a request was refused (ADR-007 §5). */
export type PresentationDeniedReason = 'notAllowed' | 'unsupported' | 'noUserGesture' | 'busy' | 'dismissed';

export interface PresentationChange {
  readonly from: PresentationMode;
  readonly to: PresentationMode;
  readonly reason?: string;
}

export interface PresentationRequestOptions {
  readonly userGesture?: Event;
  /**
   * Fullscreen through the system player (`webkitEnterFullscreen`, iPhone) instead of
   * pseudo-fullscreen: only the <video> is shown, so captions move to native TextTracks.
   */
  readonly system?: boolean;
}

export interface PresentationController {
  readonly mode: PresentationMode;
  /** Target of the transition in flight, null when idle. */
  readonly pending: PresentationMode | null;
  readonly capabilities: PresentationCapabilities;
  /** Only the <video> is on screen (system fullscreen, video PiP): custom overlays are not seen. */
  readonly videoOnly: boolean;
  /** Resolves with the mode after the browser's answer: the target, or the unchanged mode. */
  request(mode: PresentationMode, opts?: PresentationRequestOptions): Promise<PresentationMode>;
  /** Back to inline (from theater) or to the layout mode under the current one. */
  exit(): Promise<void>;
  on(e: 'change' | 'denied', h: (p: PresentationChange) => void): Unsubscribe;
  destroy(): void;
}

export interface PresentationOptions {
  /** Player root: fullscreen targets the container, never the <video> (SPEC §15). */
  readonly container: HTMLElement;
  /** Picture source for PiP. */
  readonly surface: Surface;
  /** Lock landscape in fullscreen for landscape pictures (failures are ignored). Default true. */
  readonly lockOrientation?: boolean;
  /** Initial Document PiP window size; default: the player's size. */
  readonly docPipSize?: { readonly width: number; readonly height: number };
  /** localStorage key for the mini window position (`otter:mini-position`); null: session only. */
  readonly miniPositionKey?: string | null;
}

interface WebKitVideo {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
}
/** Document Picture-in-Picture (Chrome 116+), not in lib.dom yet. */
export interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

type Layout = 'inline' | 'theater';

const TIMEOUT_MS = 1500;

/** Resolves once `ok()` holds (checked now and on each event), rejects with 'dismissed' after a timeout. */
const nextEvent = (target: EventTarget, types: readonly string[], ok: () => boolean): Promise<void> =>
  new Promise((resolve, reject) => {
    // Some engines fire the event before the request's promise settles.
    if (ok()) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      for (const t of types) target.removeEventListener(t, check);
    };
    const check = (): void => {
      if (!ok()) return;
      done();
      resolve();
    };
    const timer = setTimeout(() => {
      done();
      if (ok()) resolve();
      else reject('dismissed');
    }, TIMEOUT_MS);
    for (const t of types) target.addEventListener(t, check);
  });

export function createPresentationController(options: PresentationOptions): PresentationController {
  const { container } = options;
  const doc = container.ownerDocument;
  const win = doc.defaultView as (Window & { documentPictureInPicture?: DocumentPictureInPicture }) | null;
  const video = (options.surface.element instanceof HTMLVideoElement ? options.surface.element : undefined) as (HTMLVideoElement & WebKitVideo) | undefined;
  const bus = createEventBus<{ change: PresentationChange; denied: PresentationChange }>();
  const offs: Unsubscribe[] = [];

  let mode: PresentationMode = 'inline';
  let layout: Layout = 'inline';
  let pending: PresentationMode | null = null;
  // How the current fullscreen is done: element API, pseudo (CSS) or the iPhone system player.
  let fullscreenKind: 'native' | 'pseudo' | 'system' = 'native';
  let beforeBackground: PresentationMode = 'inline';
  let pipWindow: Window | undefined;
  let placeholder: HTMLElement | undefined;
  /** Undoes the mini window drag behaviour (mini.ts, loaded on entering mini). */
  let miniOff: (() => void) | undefined;
  let miniEpoch = 0;
  let restoreScroll: (() => void) | undefined;

  const inFullscreen = (): boolean => {
    const fs = doc.fullscreenElement;
    return fs != null && (fs === container || fs.contains(container));
  };
  const inPip = (): boolean => video !== undefined && doc.pictureInPictureElement === video;

  const capabilities: PresentationCapabilities = {
    inline: 'native',
    theater: 'emulated',
    fullscreen: doc.fullscreenEnabled === true && typeof container.requestFullscreen === 'function' ? 'native' : 'emulated',
    pip: video !== undefined && !video.disablePictureInPicture && doc.pictureInPictureEnabled === true && typeof video.requestPictureInPicture === 'function' ? 'native' : false,
    docpip: win?.documentPictureInPicture !== undefined && win.top === win ? 'native' : false,
    mini: typeof IntersectionObserver === 'function' ? 'emulated' : false,
    background: typeof doc.visibilityState === 'string' ? 'native' : false,
  };

  const set = (to: PresentationMode, reason?: string): void => {
    if (to === mode) return;
    const from = mode;
    mode = to;
    if (to === 'inline' || to === 'theater') layout = to;
    container.setAttribute('data-otter-presentation', to);
    container.toggleAttribute('data-otter-theater', to === 'theater');
    container.toggleAttribute('data-otter-emulated', to === 'mini' || (to === 'fullscreen' && fullscreenKind === 'pseudo'));
    bus.emit('change', reason === undefined ? { from, to } : { from, to, reason });
  };
  const deny = (to: PresentationMode, reason: PresentationDeniedReason): PresentationMode => {
    bus.emit('denied', { from: mode, to, reason });
    return mode;
  };

  const lockOrientation = (): void => {
    if (options.lockOrientation === false || video === undefined || video.videoWidth < video.videoHeight) return;
    try {
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => undefined);
    } catch {
      // Not in fullscreen or not supported: nothing to do (ADR-007 §5).
    }
  };
  const unlockOrientation = (): void => {
    try {
      screen.orientation?.unlock?.();
    } catch {
      // Same as above.
    }
  };

  const insertPlaceholder = (): HTMLElement => {
    const r = container.getBoundingClientRect();
    const p = doc.createElement('div');
    p.setAttribute('data-otter-placeholder', '');
    p.style.cssText = `width:${r.width}px;height:${r.height}px`;
    container.before(p);
    placeholder = p;
    return p;
  };
  const removePlaceholder = (): void => {
    placeholder?.remove();
    placeholder = undefined;
    miniEpoch++;
    miniOff?.();
    miniOff = undefined;
  };

  // Leaves the current non-layout mode. Synchronous side effects only; the browser's own events
  // (fullscreenchange, leavepictureinpicture, pagehide) confirm.
  const leave = (): Promise<void> => {
    const current = mode;
    // Deferred: by then a new request may already have taken over from `current`.
    const settle = (): void => {
      if (mode === current) set(layout);
    };
    if (current === 'fullscreen') {
      unlockOrientation();
      if (fullscreenKind === 'pseudo') {
        restoreScroll?.();
        restoreScroll = undefined;
        set(layout);
        return Promise.resolve();
      }
      if (fullscreenKind === 'system') {
        video?.webkitExitFullscreen?.();
        return nextEvent(video as HTMLVideoElement, ['webkitendfullscreen'], () => mode !== 'fullscreen').catch(settle);
      }
      return doc
        .exitFullscreen()
        .catch(() => undefined)
        .then(() => nextEvent(doc, ['fullscreenchange'], () => !inFullscreen()))
        .catch(() => undefined)
        .then(settle);
    }
    if (current === 'pip') return doc.exitPictureInPicture().catch(() => undefined).then(settle);
    if (current === 'docpip') {
      pipWindow?.close();
      return Promise.resolve();
    }
    if (current === 'mini') {
      removePlaceholder();
      set('inline');
      return Promise.resolve();
    }
    if (current === 'theater') set('inline');
    return Promise.resolve();
  };

  const refusal = (err: unknown, active: boolean): PresentationDeniedReason => {
    if (err === 'dismissed') return 'dismissed';
    if (!active) return 'noUserGesture';
    const name = (err as { name?: string } | null)?.name;
    return name === 'NotSupportedError' ? 'unsupported' : 'notAllowed';
  };

  // Calls the browser API synchronously; the promise settles with the browser's answer.
  const enter = (to: PresentationMode, opts: PresentationRequestOptions): Promise<void> => {
    if (to === 'theater') {
      set('theater');
      return Promise.resolve();
    }
    if (to === 'mini') {
      insertPlaceholder();
      set('mini');
      const epoch = ++miniEpoch;
      void import('./mini.js').then((m) => {
        if (epoch === miniEpoch && mode === 'mini') miniOff = m.attachMini(container, { storageKey: options.miniPositionKey === undefined ? 'otter:mini-position' : options.miniPositionKey });
      });
      return Promise.resolve();
    }
    if (to === 'fullscreen') {
      if (opts.system === true && typeof video?.webkitEnterFullscreen === 'function') {
        fullscreenKind = 'system';
        video.webkitEnterFullscreen();
        return nextEvent(video, ['webkitbeginfullscreen'], () => video.webkitDisplayingFullscreen === true);
      }
      if (capabilities.fullscreen === 'emulated') {
        // Pseudo-fullscreen (SPEC §15): the container covers the viewport and the page stops
        // scrolling, so custom UI, captions and danmaku stay. The status bar remains.
        fullscreenKind = 'pseudo';
        const roots = [doc.documentElement, doc.body];
        const saved = roots.map((r) => r.style.overflow);
        for (const r of roots) r.style.overflow = 'hidden';
        restoreScroll = () => roots.forEach((r, i) => (r.style.overflow = saved[i] ?? ''));
        return Promise.resolve();
      }
      fullscreenKind = 'native';
      return container.requestFullscreen().then(() => nextEvent(doc, ['fullscreenchange'], inFullscreen));
    }
    if (to === 'pip') return (video as HTMLVideoElement).requestPictureInPicture().then(() => undefined);
    // docpip
    const size = options.docPipSize ?? { width: Math.round(container.clientWidth) || 640, height: Math.round(container.clientHeight) || 360 };
    const opened = (win?.documentPictureInPicture as DocumentPictureInPicture).requestWindow(size);
    return opened.then(async (w) => {
      pipWindow = w;
      const { moveInto } = await import('./docpip.js');
      const back = moveInto(container, w, video);
      w.addEventListener(
        'pagehide',
        () => {
          back();
          pipWindow = undefined;
          if (mode === 'docpip') set(layout);
        },
        { once: true },
      );
    });
  };

  const controller: PresentationController = {
    get mode() {
      return mode;
    },
    get pending() {
      return pending;
    },
    capabilities,
    get videoOnly() {
      return (mode === 'fullscreen' && fullscreenKind === 'system') || mode === 'pip';
    },
    request(to, opts = {}) {
      if (pending !== null) return Promise.resolve(deny(to, 'busy'));
      if (to === mode) return Promise.resolve(mode);
      if (to === 'inline') return controller.exit().then(() => mode);
      if (to === 'background' || capabilities[to] === false) return Promise.resolve(deny(to, 'unsupported'));
      const active = (navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true;
      // From fullscreen / PiP / mini, step out first (synchronously) so the new request keeps the
      // gesture; the layout mode (inline / theater) stays underneath.
      if (mode !== 'inline' && mode !== 'theater') void leave();
      pending = to;
      let entering: Promise<void>;
      try {
        entering = enter(to, opts);
      } catch (err) {
        entering = Promise.reject(err);
      }
      return entering.then(
        () => {
          pending = null;
          set(to);
          if (to === 'fullscreen') lockOrientation();
          return mode;
        },
        (err: unknown) => {
          pending = null;
          if (to === 'fullscreen') {
            restoreScroll?.();
            restoreScroll = undefined;
          }
          return deny(to, refusal(err, active));
        },
      );
    },
    exit() {
      return mode === 'inline' || mode === 'background' ? Promise.resolve() : leave();
    },
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      if (mode !== 'inline') void leave();
      for (const off of offs.splice(0)) off();
      bus.clear();
    },
  };

  // ---- Passive transitions: the user or the browser left a mode ------------------------------
  const listen = (target: EventTarget | undefined, types: readonly string[], h: () => void): void => {
    if (target === undefined) return;
    for (const t of types) target.addEventListener(t, h);
    offs.push(() => {
      for (const t of types) target.removeEventListener(t, h);
    });
  };
  listen(doc, ['fullscreenchange'], () => {
    if (mode === 'fullscreen' && fullscreenKind === 'native' && !inFullscreen()) {
      unlockOrientation();
      set(layout, 'exited');
    }
  });
  listen(video, ['leavepictureinpicture'], () => {
    if (mode === 'pip' && !inPip()) set(layout, 'exited');
  });
  listen(video, ['webkitendfullscreen'], () => {
    if (mode === 'fullscreen' && fullscreenKind === 'system') set(layout, 'exited');
  });
  listen(doc, ['visibilitychange'], () => {
    if (doc.visibilityState === 'hidden' && (mode === 'inline' || mode === 'theater' || mode === 'mini')) {
      beforeBackground = mode;
      set('background', 'hidden');
    } else if (doc.visibilityState === 'visible' && mode === 'background') {
      set(beforeBackground, 'visible');
    }
  });
  container.setAttribute('data-otter-presentation', mode);
  return controller;
}
