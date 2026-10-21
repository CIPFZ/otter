// Video PiP for a canvas picture (SPEC §15, ADR-008 §8): browsers put only a <video> in a PiP
// window, so a picture drawn on a canvas (the WebCodecs path) goes there through a hidden <video>
// fed by canvas.captureStream(). The stream video is kept ready while the canvas shows the
// picture: requestPictureInPicture() must run synchronously inside the user's gesture and fails
// before the video has metadata. A sub-entry (`@otter-player/presentation/canvas-pip`) that hosts
// with a canvas picture wire in, so the first screen does not carry it:
//
//   let pip: CanvasPip | undefined;
//   createPresentationPlugin({ ...options, ...(canvasPipSupported(document) ? { pipVideo: () => pip?.pipVideo() } : {}) });
//   pip = bindCanvasPip(document, store, () => canvasShowingThePicture);

export interface CanvasPip {
  /** For PresentationOptions.pipVideo: the stream video while a canvas shows the picture. */
  pipVideo(): HTMLVideoElement | undefined;
  destroy(): void;
}

export const canvasPipSupported = (doc: Document): boolean =>
  doc.pictureInPictureEnabled === true &&
  typeof HTMLCanvasElement === 'function' &&
  'captureStream' in HTMLCanvasElement.prototype &&
  'requestPictureInPicture' in HTMLVideoElement.prototype;

/** The parts of the player's store this uses (MediaState's `paused`, MediaActionMap's play / pause). */
export interface CanvasPipStore {
  getState(): { readonly paused?: boolean };
  subscribe(h: () => void): () => void;
  dispatch(type: 'play' | 'pause', payload: undefined): unknown;
}

/**
 * Follows `canvas()` (read on every state change) with a stream video, mirrors the player's paused
 * state into it, and the PiP window's play / pause back to the player.
 */
export function bindCanvasPip(doc: Document, s: CanvasPipStore, canvas: () => HTMLCanvasElement | undefined): CanvasPip {
  /** The canvas showing the picture now (undefined: the <video> does). */
  let source: HTMLCanvasElement | undefined;
  /** The canvas the stream video captures: kept while the canvas is only hidden for a moment. */
  let captured: HTMLCanvasElement | undefined;
  let video: HTMLVideoElement | undefined;
  let ready = false;
  let playerPaused = s.getState().paused !== false;

  const stop = (v: HTMLVideoElement): void => {
    for (const t of (v.srcObject as MediaStream | null)?.getTracks() ?? []) t.stop();
    v.srcObject = null;
    v.remove();
  };
  const drop = (): void => {
    if (video === undefined || doc.pictureInPictureElement === video) return; // keep the open window's source
    stop(video);
    video = undefined;
    captured = undefined;
    ready = false;
  };
  const follow = (): void => {
    // The PiP window's play / pause: only when it differs from the player (our own mirroring
    // changes the video's state too, and must not echo back).
    if (video !== undefined && ready && video.paused !== playerPaused) void s.dispatch(video.paused ? 'pause' : 'play', undefined);
  };
  const prepare = (next: HTMLCanvasElement | undefined): void => {
    source = next;
    // Hidden (a seek or a reset clears the picture) or back again: the same stream video, which
    // stays ready; a new video would need its metadata again before PiP could open.
    if (next === undefined || next === captured) return;
    drop();
    if (video !== undefined) return;
    captured = next;
    const v = doc.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('aria-hidden', 'true');
    v.dataset['otterPip'] = '';
    // Not display:none: some engines refuse PiP for undisplayed videos.
    v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    v.srcObject = next.captureStream();
    v.addEventListener('loadedmetadata', () => (ready = true), { once: true });
    v.addEventListener('play', follow);
    v.addEventListener('pause', follow);
    doc.body.append(v);
    video = v;
    void v.play().catch(() => undefined);
    if (playerPaused) v.pause();
  };
  const update = (): void => {
    prepare(canvas());
    // Only on a change of the player's state: the store reports every tick, and re-mirroring
    // between the window's pause() and its 'pause' event would undo the user's press.
    const paused = s.getState().paused !== false;
    if (paused === playerPaused) return;
    playerPaused = paused;
    if (video === undefined) return;
    if (paused && !video.paused) video.pause();
    else if (!paused && video.paused) void video.play().catch(() => undefined);
  };
  const off = s.subscribe(update);
  update();

  return {
    pipVideo() {
      // The open window's video counts as long as it is open (the canvas may be gone already).
      // Before its metadata the browser refuses PiP for it (InvalidStateError: denied).
      return source !== undefined || doc.pictureInPictureElement === video ? video : undefined;
    },
    destroy() {
      off();
      if (video !== undefined) stop(video);
      video = undefined;
      source = captured = undefined;
    },
  };
}
