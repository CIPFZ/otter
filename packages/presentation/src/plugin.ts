// Store integration (ADR-007 §5): the PresentationController as a plugin. The UI reads
// `presentation` / `cast` / `airplay` and dispatches the actions below; handlers call the browser
// API synchronously inside the dispatch that the click / key / gesture made, so the user
// activation is still there. Also owns the companions: orientation lock (in the controller), and
// in a chunk loaded at install (not first-screen code): auto mini window, WakeLock, MediaSession
// and casting.

import type { Plugin, PluginContext, Store, StoreSlice, Unsubscribe } from '@otter-player/core';
import type { MediaSessionActions } from './companions.js';
import {
  createPresentationController,
  type PresentationCapabilities,
  type PresentationController,
  type PresentationMode,
  type PresentationOptions,
} from './controller.js';
import type { RemoteControl, RemoteState } from './remote.js';

export interface PresentationSnapshot {
  readonly mode: PresentationMode;
  readonly pending: PresentationMode | null;
  readonly capabilities: PresentationCapabilities;
  readonly videoOnly: boolean;
}

export interface PresentationState {
  readonly presentation: PresentationSnapshot;
  readonly cast: RemoteState;
  readonly airplay: RemoteState;
  /** A screen WakeLock is held (playing and visible). */
  readonly wakeLocked: boolean;
}

const NONE: PresentationCapabilities = { inline: 'native', theater: false, fullscreen: false, pip: false, docpip: false, mini: false, background: false };

export const INITIAL_PRESENTATION_STATE: PresentationState = {
  presentation: { mode: 'inline', pending: null, capabilities: NONE, videoOnly: false },
  cast: 'unavailable',
  airplay: 'unavailable',
  wakeLocked: false,
};
export const PRESENTATION_SLICE: StoreSlice<PresentationState> = { id: 'presentation', initialState: INITIAL_PRESENTATION_STATE };

/** Shares names with InputActionMap (`toggle-fullscreen`, `toggle-pip`, `toggle-mini`). */
export interface PresentationActionMap {
  'request-presentation': { readonly mode: PresentationMode; readonly system?: boolean };
  'exit-presentation': Record<string, never>;
  'toggle-fullscreen': Record<string, never>;
  'toggle-pip': Record<string, never>;
  'toggle-theater': Record<string, never>;
  'toggle-mini': Record<string, never>;
  /** Esc with no menu open: leaves fullscreen (the browser only does that for the native one). */
  'exit-fullscreen': Record<string, never>;
  'open-cast-picker': Record<string, never>;
  'open-airplay-picker': Record<string, never>;
}

export interface PresentationPluginOptions extends PresentationOptions {
  /** Enter the page mini window when the player scrolls out of view while playing. */
  readonly autoMini?: boolean;
  /** `toggle-pip` opens Document PiP where available (keeps the whole UI). Default false. */
  readonly preferDocumentPip?: boolean;
  /** MediaSession metadata; false turns MediaSession off. */
  readonly mediaSession?: false | { readonly metadata?: MediaMetadataInit };
  /** Hold a screen WakeLock while playing and visible. Default true. */
  readonly wakeLock?: boolean;
}

export interface PresentationPlugin<S extends PresentationState> extends Plugin<S, PresentationActionMap> {
  /** The controller, once installed. */
  readonly controller: PresentationController | undefined;
  /** Settles when the companions (WakeLock, MediaSession, casting) are running. */
  readonly ready: Promise<void>;
}

export function createPresentationPlugin<S extends PresentationState>(options: PresentationPluginOptions): PresentationPlugin<S> {
  const video = options.surface.element instanceof HTMLVideoElement ? options.surface.element : undefined;
  const doc = options.container.ownerDocument;
  let controller: PresentationController | undefined;
  let offs: Unsubscribe[] = [];
  let ready: Promise<void> = Promise.resolve();

  return {
    id: 'presentation',
    get controller() {
      return controller;
    },
    get ready() {
      return ready;
    },
    install(ctx: PluginContext<S, PresentationActionMap>) {
      const store = ctx.store;
      const c = createPresentationController(options);
      controller = c;
      const sync = (): void =>
        store.setState({ presentation: { mode: c.mode, pending: c.pending, capabilities: c.capabilities, videoOnly: c.videoOnly } } as Partial<S>);
      const request = (mode: PresentationMode, system?: boolean): void => {
        void c.request(mode, system === true ? { system } : {});
        sync();
      };
      const toggle = (mode: PresentationMode): void => (c.mode === mode ? void c.exit() : request(mode));
      offs = [
        c.on('change', (p) => {
          sync();
          ctx.qoe.emit('presentation-change', p);
        }),
        c.on('denied', (p) => {
          sync();
          ctx.qoe.emit('presentation-denied', { from: p.from, to: p.to, reason: p.reason ?? 'notAllowed' });
        }),
        store.handle('request-presentation', ({ mode, system }) => request(mode, system)),
        store.handle('exit-presentation', () => void c.exit()),
        store.handle('toggle-fullscreen', () => toggle('fullscreen')),
        store.handle('toggle-theater', () => toggle('theater')),
        store.handle('toggle-mini', () => toggle('mini')),
        store.handle('toggle-pip', () => {
          if (c.mode === 'pip' || c.mode === 'docpip') return void c.exit();
          const doc = c.capabilities.docpip !== false && (options.preferDocumentPip === true || c.capabilities.pip === false);
          request(doc ? 'docpip' : 'pip');
        }),
        store.handle('exit-fullscreen', () => {
          if (c.mode === 'fullscreen') void c.exit();
        }),
      ];
      // The pickers open synchronously in the click; before the chunk is in, there is nothing to
      // show anyway (the buttons appear once a receiver is reported).
      let remote: RemoteControl | undefined;
      offs.push(
        store.handle('open-cast-picker', () => remote?.prompt('cast')),
        store.handle('open-airplay-picker', () => remote?.prompt('airplay')),
        () => c.destroy(),
      );
      ready = import('./companions.js').then((m) => {
        if (controller !== c) return;
        remote = m.createRemoteControl(video, (patch) => store.setState(patch as Partial<S>));
        offs.push(() => remote?.destroy());
        if (options.autoMini === true && c.capabilities.mini !== false) offs.push(m.autoMini(c, options.container, video));
        if (options.wakeLock !== false) offs.push(m.holdWakeLock(store, doc));
        if (options.mediaSession !== false) offs.push(m.bindMediaSession(store as unknown as Store<S, MediaSessionActions>, options.mediaSession?.metadata));
      });
      sync();
    },
    uninstall() {
      for (const off of offs.splice(0)) off();
      controller = undefined;
    },
  };
}
