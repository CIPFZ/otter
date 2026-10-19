// PresentationController (SPEC §15): window-mode state machine. Every transition is
// request -> async browser result -> confirm or roll back; nothing is applied optimistically.
//
// User activation: implementations must call the browser API (requestFullscreen,
// requestPictureInPicture, screen.orientation.lock, documentPictureInPicture.requestWindow)
// synchronously inside request(), before the first await, so the gesture is not lost.

import { notImplemented, type Plugin, type PluginContext, type Store, type StoreSlice, type StoreView, type Unsubscribe } from '@otter-player/core';
import type { Surface } from '@otter-player/surface';

export type PresentationMode = 'inline' | 'theater' | 'fullscreen' | 'pip' | 'docpip' | 'mini' | 'background';

export type PresentationSupport = 'native' | 'emulated' | false;

export interface PresentationChange {
  from: PresentationMode;
  to: PresentationMode;
  reason?: string;
}

export interface PresentationController {
  readonly mode: PresentationMode;
  readonly capabilities: Readonly<Record<PresentationMode, PresentationSupport>>;
  request(mode: PresentationMode, opts?: { userGesture?: Event }): Promise<PresentationMode>;
  exit(): Promise<void>;
  on(e: 'change' | 'denied', h: (p: PresentationChange) => void): Unsubscribe;
}

export interface PresentationOptions<S extends object = object, A extends object = object> {
  /** Player root: fullscreen targets the container, never the <video> (SPEC §15). */
  readonly container: HTMLElement;
  /** Picture source for PiP; the controller goes through the Surface, not the engine. */
  readonly surface: Surface;
  readonly store: StoreView<S, A>;
}

const INLINE_ONLY: Readonly<Record<PresentationMode, PresentationSupport>> = {
  inline: 'native',
  theater: false,
  fullscreen: false,
  pip: false,
  docpip: false,
  mini: false,
  background: false,
};

const noop: Unsubscribe = () => undefined;

/** M0 empty implementation: stays inline, every request is rejected as notImplemented. */
export function createPresentationController<S extends object, A extends object>(
  _options: PresentationOptions<S, A>,
): PresentationController {
  return {
    mode: 'inline',
    capabilities: INLINE_ONLY,
    request: (mode) => Promise.reject(notImplemented(`@otter-player/presentation request(${mode})`)),
    exit: () => Promise.resolve(),
    on: () => noop,
  };
}

// ------------------------------------------------------------------------------------------------
// M2 interim (ADR-005 §5): fullscreen and picture-in-picture as plain store actions until the
// full state machine above lands in M3. Handlers call the browser API synchronously, inside the
// dispatch that the input / UI event made, so the user activation is still there.


export interface PresentationState {
  readonly fullscreen: boolean;
  readonly pip: boolean;
  readonly fullscreenAvailable: boolean;
  readonly pipAvailable: boolean;
}

export const INITIAL_PRESENTATION_STATE: PresentationState = { fullscreen: false, pip: false, fullscreenAvailable: false, pipAvailable: false };
export const PRESENTATION_SLICE: StoreSlice<PresentationState> = { id: 'presentation', initialState: INITIAL_PRESENTATION_STATE };

/** Shares names with InputActionMap (`toggle-fullscreen`, `toggle-pip`). */
export interface PresentationActionMap {
  'toggle-fullscreen': Record<string, never>;
  'toggle-pip': Record<string, never>;
}

interface WebKitDocument {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
}
interface WebKitElement {
  webkitRequestFullscreen?: () => void;
}
interface WebKitVideo {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
}

export function createPresentationPlugin<S extends PresentationState>(options: Pick<PresentationOptions, 'container' | 'surface'>): Plugin<S, PresentationActionMap> {
  const { container } = options;
  const video = options.surface.element instanceof HTMLVideoElement ? options.surface.element : undefined;
  const doc = container.ownerDocument as Document & WebKitDocument;
  let store: Store<S, PresentationActionMap> | undefined;
  let offs: Unsubscribe[] = [];

  const fullscreenElement = (): Element | null => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  const isFullscreen = (): boolean => {
    const fs = fullscreenElement();
    return (fs !== null && (fs === container || fs.contains(container) || container.contains(fs))) || (video as WebKitVideo | undefined)?.webkitDisplayingFullscreen === true;
  };
  const isPip = (): boolean =>
    (video !== undefined && doc.pictureInPictureElement === video) || (video as WebKitVideo | undefined)?.webkitPresentationMode === 'picture-in-picture';
  const refresh = (): void => {
    const v = video as (HTMLVideoElement & WebKitVideo) | undefined;
    store?.setState({
      fullscreen: isFullscreen(),
      pip: isPip(),
      fullscreenAvailable:
        doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true || typeof v?.webkitEnterFullscreen === 'function',
      pipAvailable:
        v !== undefined &&
        !v.disablePictureInPicture &&
        ((doc.pictureInPictureEnabled === true && typeof v.requestPictureInPicture === 'function') ||
          v.webkitSupportsPresentationMode?.('picture-in-picture') === true),
    } as Partial<S>);
  };
  const ignore = (p: Promise<unknown> | undefined | void): void => {
    // Denied requests (no activation, policy) leave the state as it is; refresh() reports truth.
    if (p instanceof Promise) p.catch(() => undefined).finally(refresh);
  };

  return {
    id: 'presentation',
    install(ctx: PluginContext<S, PresentationActionMap>) {
      store = ctx.store;
      offs = [
        ctx.store.handle('toggle-fullscreen', () => {
          const v = video as (HTMLVideoElement & WebKitVideo) | undefined;
          if (isFullscreen()) {
            if (fullscreenElement() !== null) ignore(doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
            else v?.webkitExitFullscreen?.();
            return;
          }
          const el = container as HTMLElement & WebKitElement;
          if (typeof el.requestFullscreen === 'function' && doc.fullscreenEnabled !== false) ignore(el.requestFullscreen());
          else if (typeof el.webkitRequestFullscreen === 'function') el.webkitRequestFullscreen();
          // iPhone: only the <video> can go fullscreen (system player; SPEC §15).
          else v?.webkitEnterFullscreen?.();
        }),
        ctx.store.handle('toggle-pip', () => {
          const v = video as (HTMLVideoElement & WebKitVideo) | undefined;
          if (v === undefined) return;
          if (isPip()) {
            if (doc.pictureInPictureElement != null) ignore(doc.exitPictureInPicture());
            else v.webkitSetPresentationMode?.('inline');
            return;
          }
          if (typeof v.requestPictureInPicture === 'function' && doc.pictureInPictureEnabled === true) ignore(v.requestPictureInPicture());
          else v.webkitSetPresentationMode?.('picture-in-picture');
        }),
      ];
      const listen = (target: EventTarget, types: readonly string[]): void => {
        for (const t of types) target.addEventListener(t, refresh);
        offs.push(() => {
          for (const t of types) target.removeEventListener(t, refresh);
        });
      };
      listen(doc, ['fullscreenchange', 'webkitfullscreenchange']);
      if (video !== undefined) listen(video, ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged', 'webkitbeginfullscreen', 'webkitendfullscreen', 'loadedmetadata']);
      refresh();
    },
    uninstall() {
      for (const off of offs) off();
      offs = [];
      store = undefined;
    },
  };
}
