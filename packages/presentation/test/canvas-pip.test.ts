// @vitest-environment happy-dom
// Video PiP of a canvas picture (SPEC §15): the stream video follows the canvas, mirrors the
// player's paused state only on changes, and the PiP window's play / pause reach the player.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCanvasPip, type CanvasPipStore } from '@otter-player/presentation/canvas-pip';

function fakeStore(paused: boolean) {
  let state = { paused, currentTime: 0 };
  const subs = new Set<() => void>();
  const dispatched: string[] = [];
  const store: CanvasPipStore = {
    getState: () => state,
    subscribe: (h) => (subs.add(h), () => void subs.delete(h)),
    dispatch: (type) => void dispatched.push(type),
  };
  const set = (patch: Partial<typeof state>): void => {
    state = { ...state, ...patch };
    for (const h of subs) h();
  };
  return { store, set, dispatched };
}

function fakeCanvas() {
  const canvas = document.createElement('canvas');
  const stop = vi.fn();
  (canvas as unknown as { captureStream: () => unknown }).captureStream = () => ({ getTracks: () => [{ stop }] });
  return { canvas, stop };
}

/**
 * A video whose play() / pause() set `paused` and fire the events, as browsers do (happy-dom's do
 * not), and that takes a fake stream.
 */
function playable(v: HTMLVideoElement): HTMLVideoElement {
  let paused = true;
  Object.defineProperty(v, 'paused', { get: () => paused });
  Object.defineProperty(v, 'srcObject', { value: null, writable: true });
  v.play = () => {
    if (paused) {
      paused = false;
      v.dispatchEvent(new Event('play'));
    }
    return Promise.resolve();
  };
  v.pause = () => {
    if (!paused) {
      paused = true;
      v.dispatchEvent(new Event('pause'));
    }
  };
  return v;
}

describe('bindCanvasPip', () => {
  beforeEach(() => {
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      return tag === 'video' ? playable(el as HTMLVideoElement) : el;
    }) as typeof document.createElement);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps a muted, hidden stream video while a canvas shows the picture', () => {
    const { store } = fakeStore(true);
    const { canvas, stop } = fakeCanvas();
    const pip = bindCanvasPip(document, store, () => canvas);
    const v = pip.pipVideo();
    expect(v).toBeInstanceOf(HTMLVideoElement);
    expect(v?.muted).toBe(true);
    expect(v?.isConnected).toBe(true);
    expect(v?.dataset['otterPip']).toBe('');
    pip.destroy();
    expect(stop).toHaveBeenCalled();
    expect(v?.isConnected).toBe(false);
    expect(pip.pipVideo()).toBeUndefined();
  });

  it('drops the stream when the canvas goes, and gives undefined (the <video>) then', () => {
    const { store, set } = fakeStore(true);
    const { canvas, stop } = fakeCanvas();
    let shown: HTMLCanvasElement | undefined = canvas;
    const pip = bindCanvasPip(document, store, () => shown);
    const v = pip.pipVideo();
    shown = undefined;
    set({ currentTime: 1 });
    expect(pip.pipVideo()).toBeUndefined();
    expect(v?.isConnected).toBe(false);
    expect(stop).toHaveBeenCalled();
    pip.destroy();
  });

  it('mirrors the player only on changes, and passes the window’s play / pause to the player', () => {
    const { store, set, dispatched } = fakeStore(false);
    const { canvas } = fakeCanvas();
    const pip = bindCanvasPip(document, store, () => canvas);
    const v = pip.pipVideo() as HTMLVideoElement;
    v.dispatchEvent(new Event('loadedmetadata'));
    expect(v.paused).toBe(false);
    // The PiP window's pause: to the player; ticks before the store has it do not undo it.
    v.pause();
    set({ currentTime: 2 });
    expect(v.paused).toBe(true);
    expect(dispatched).toEqual(['pause']);
    set({ paused: true });
    // The player plays: mirrored, without echoing back.
    set({ paused: false });
    expect(v.paused).toBe(false);
    expect(dispatched).toEqual(['pause']);
    // The window's play while the player is paused.
    set({ paused: true });
    v.play();
    expect(dispatched).toEqual(['pause', 'play']);
    pip.destroy();
  });
});
