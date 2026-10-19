// @otter-player/presentation (SPEC §15, ADR-007 §5): window-mode state machine, its store plugin
// and the companions (orientation lock; WakeLock, MediaSession and casting load at install).

export {
  createPresentationController,
  type DocumentPictureInPicture,
  type PresentationCapabilities,
  type PresentationChange,
  type PresentationController,
  type PresentationDeniedReason,
  type PresentationMode,
  type PresentationOptions,
  type PresentationRequestOptions,
  type PresentationSupport,
} from './controller.js';
export {
  createPresentationPlugin,
  INITIAL_PRESENTATION_STATE,
  PRESENTATION_SLICE,
  type PresentationActionMap,
  type PresentationPlugin,
  type PresentationPluginOptions,
  type PresentationSnapshot,
  type PresentationState,
} from './plugin.js';
export type { RemoteControl, RemoteState, RemoteStates } from './remote.js';
