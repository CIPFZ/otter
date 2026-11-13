// Store integration (ADR-007 §5): the PresentationController as a plugin. The UI reads
// `presentation` / `cast` / `airplay` and dispatches the actions below; handlers call the browser
// API synchronously inside the dispatch that the click / key / gesture made, so the user
// activation is still there. Also owns the helpers: orientation lock (in the controller), and
// in a chunk loaded at install (not first-screen code): auto mini window, WakeLock, MediaSession
// and casting.

import type { Plugin, PluginContext, Store, StoreSlice, Unsubscribe } from '@otter-player/core';
import type { CompanionRuntime } from './companion.js';
import type { MediaSessionActions } from './helpers.js';
import {
  createPresentationController,
  type PresentationCapabilities,
  type PresentationController,
  type PresentationMode,
  type PresentationOptions,
  type PresentationRequestOptions,
} from './controller.js';
import type { RemoteControl, RemoteState } from './remote.js';

/** Companion window width: 240 / 320 / 440 px; the height follows the picture (ADR-016). */
export type CompanionSize = 's' | 'm' | 'l';

/** Companion mode (ADR-016): the player in a Document PiP window, dimmed, controls on hover. */
export interface CompanionOptions {
  /** Dimming of the picture in the window, 0..0.8. Default 0.4. */
  readonly dim?: number;
  /** Window width step. Default `'m'`. */
  readonly size?: CompanionSize;
  /** Audio strip instead of the picture. Default false. */
  readonly audioOnly?: boolean;
  /** Danmaku and captions off while in the window, back on leaving. Default true. */
  readonly quiet?: boolean;
  /** When the viewer closes the window: pause, or keep playing in the page. Default `'pause'`. */
  readonly onClose?: 'pause' | 'continue';
  /** Keep dim, size and audioOnly in the viewer's preferences. Default true. */
  readonly remember?: boolean;
}

/** What `companion-set` changes. */
export interface CompanionSettings {
  readonly dim?: number;
  readonly size?: CompanionSize;
  readonly audioOnly?: boolean;
}

/** Companion mode state (`presentation.companion`). */
export interface CompanionState {
  /** The host turned companion mode on and this browser has Document PiP (not in an iframe). */
  readonly supported: boolean;
  /** In the companion window now (mode `docpip`). */
  readonly active: boolean;
  readonly dim: number;
  readonly size: CompanionSize;
  readonly audioOnly: boolean;
  /** dim, size and audioOnly go to the preferences (CompanionOptions.remember). */
  readonly remember: boolean;
}

export interface PresentationSnapshot {
  readonly mode: PresentationMode;
  readonly pending: PresentationMode | null;
  readonly capabilities: PresentationCapabilities;
  readonly videoOnly: boolean;
  readonly companion: CompanionState;
}

export interface PresentationState {
  readonly presentation: PresentationSnapshot;
  readonly cast: RemoteState;
  readonly airplay: RemoteState;
  /** A screen WakeLock is held (playing and visible). */
  readonly wakeLocked: boolean;
}

const NONE: PresentationCapabilities = { inline: 'native', theater: false, fullscreen: false, pip: false, docpip: false, mini: false, background: false };
/** Companion mode off (the host did not turn it on, or it is not loaded yet). */
const NO_COMPANION: CompanionState = { supported: false, active: false, dim: 0.4, size: 'm', audioOnly: false, remember: true };

export const INITIAL_PRESENTATION_STATE: PresentationState = {
  presentation: { mode: 'inline', pending: null, capabilities: NONE, videoOnly: false, companion: NO_COMPANION },
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
  /** Into the companion window, or out of it (denied `unsupported` where Document PiP is missing). */
  'toggle-companion': Record<string, never>;
  /** Changes companion dim / size / audioOnly; in the window at once (a resize needs a gesture). */
  'companion-set': CompanionSettings;
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
  /**
   * Companion mode (ADR-016): `toggle-pip` opens the companion window where Document PiP exists.
   * Default off; its code is an on-demand chunk loaded at install when on.
   */
  readonly companion?: boolean | CompanionOptions;
}

export interface PresentationPlugin<S extends PresentationState> extends Plugin<S, PresentationActionMap> {
  /** The controller, once installed. */
  readonly controller: PresentationController | undefined;
  /** Settles when the helpers (WakeLock, MediaSession, casting) are running. */
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
      let companion: CompanionRuntime | undefined;
      const sync = (): void =>
        store.setState({
          presentation: { mode: c.mode, pending: c.pending, capabilities: c.capabilities, videoOnly: c.videoOnly, companion: companion?.state() ?? NO_COMPANION },
        } as Partial<S>);
      const request = (mode: PresentationMode, system?: boolean): void => {
        const opts: { -readonly [K in keyof PresentationRequestOptions]: PresentationRequestOptions[K] } = system === true ? { system } : {};
        if (mode === 'docpip' && companion?.supported === true) opts.docPipSize = companion.windowSize();
        void c.request(mode, opts);
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
          const doc = c.capabilities.docpip !== false && (companion?.supported === true || options.preferDocumentPip === true || c.capabilities.pip === false);
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
      ready = import('./helpers.js').then((m) => {
        if (controller !== c) return;
        remote = m.createRemoteControl(video, (patch) => store.setState(patch as Partial<S>));
        offs.push(() => remote?.destroy());
        if (options.autoMini === true && c.capabilities.mini !== false) offs.push(m.autoMini(c, options.container, video));
        if (options.wakeLock !== false) offs.push(m.holdWakeLock(store, doc));
        if (options.mediaSession !== false) offs.push(m.bindMediaSession(store as unknown as Store<S, MediaSessionActions>, options.mediaSession?.metadata));
      });
      sync();
      if (options.companion === undefined || options.companion === false) return;
      const settings = options.companion === true ? {} : options.companion;
      // Installed before the plugins after this one, so a preferences plugin finds the handlers.
      return import('./companion.js').then((m) => {
        if (controller !== c) return;
        companion = m.createCompanion({ controller: c, container: options.container, surface: options.surface, store, qoe: ctx.qoe, options: settings, request: () => request('docpip'), sync });
        offs.push(() => companion?.destroy());
        sync();
      });
    },
    uninstall() {
      for (const off of offs.splice(0)) off();
      controller = undefined;
    },
  };
}
