// @vitest-environment happy-dom
// Remote input (ADR-013 batch 4): the key map (names and platform codes, configurable), the
// hold-to-seek steps and their throttle, Back and OK on the picture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindRemote, DEFAULT_REMOTE_KEYS, holdStep, remoteKeyOf, type RemoteStore } from '../src/remote.js';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function setup(options?: Parameters<typeof bindRemote>[2]) {
  const root = document.body.appendChild(document.createElement('div'));
  root.tabIndex = 0;
  root.focus();
  const sent: [string, Record<string, unknown>][] = [];
  const store: RemoteStore = { getState: () => ({ menu: null }), dispatch: (type, payload) => (sent.push([type, payload]), true) };
  const off = bindRemote(root, store, options);
  const key = (init: KeyboardEventInit, type: 'keydown' | 'keyup' = 'keydown') => root.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
  return { root, sent, off, key };
}

describe('remote key map', () => {
  it('keeps separate Play and Pause keys absolute, including platform codes', () => {
    const { sent, key, off } = setup();
    key({ key: 'MediaPause' });
    key({ key: 'MediaPause', repeat: true });
    key({ key: 'MediaPlay' });
    key({ key: 'Unidentified', keyCode: 19 });
    key({ key: 'Unidentified', keyCode: 415 });
    expect(sent).toEqual([['pause', {}], ['play', {}], ['pause', {}], ['play', {}]]);
    off();
  });

  it('maps key names and platform key codes to logical keys; a host map replaces a key\'s list', () => {
    expect(remoteKeyOf({ key: 'Escape', keyCode: 27 }, DEFAULT_REMOTE_KEYS)).toBe('back');
    expect(remoteKeyOf({ key: 'Unidentified', keyCode: 10009 }, DEFAULT_REMOTE_KEYS)).toBe('back');
    expect(remoteKeyOf({ key: 'Unidentified', keyCode: 461 }, DEFAULT_REMOTE_KEYS)).toBe('back');
    expect(remoteKeyOf({ key: 'Unidentified', keyCode: 10252 }, DEFAULT_REMOTE_KEYS)).toBe('playPause');
    expect(remoteKeyOf({ key: 'Unidentified', keyCode: 417 }, DEFAULT_REMOTE_KEYS)).toBe('fastForward');
    const { sent, key } = setup({ keys: { back: ['b'] } });
    key({ key: 'Escape', keyCode: 27 });
    expect(sent).toEqual([]);
    key({ key: 'b', keyCode: 66 });
    expect(sent).toEqual([['escape', {}]]);
  });

  it('OK and Play / Pause on the picture toggle once per press, not on key repeat', () => {
    const { sent, key } = setup();
    key({ key: 'Enter' });
    key({ key: 'Enter', repeat: true });
    key({ key: 'Unidentified', keyCode: 10252 });
    expect(sent).toEqual([
      ['toggle-paused', {}],
      ['toggle-paused', {}],
    ]);
  });
});

describe('hold to seek', () => {
  it('steps grow with the time held (10 s, 30 s after 1.5 s, 60 s after 4 s by default)', () => {
    expect([0, 1000, 1500, 3999, 4000, 9000].map((t) => holdStep(t))).toEqual([10, 10, 30, 30, 60, 60]);
    expect(holdStep(700, [[0, 2], [600, 6]])).toBe(6);
  });

  it('one step per press; while held at most one step per interval, larger as the hold goes on; a release starts over', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { sent, key } = setup();
    key({ key: 'ArrowRight' });
    // Key repeat every 50 ms for 5 s.
    for (let t = 50; t <= 5000; t += 50) {
      vi.advanceTimersByTime(50);
      key({ key: 'ArrowRight', repeat: true });
    }
    const steps = sent.map(([, p]) => p['seconds']);
    expect(sent.every(([t]) => t === 'seek-by')).toBe(true);
    // 1 + one per 250 ms over 5 s (20), not one per repeat (100).
    expect(steps).toHaveLength(21);
    expect(steps.slice(0, 6)).toEqual([10, 10, 10, 10, 10, 10]);
    expect(steps).toContain(30);
    expect(steps.at(-1)).toBe(60);
    // Released, pressed again: 10 s.
    key({ key: 'ArrowRight' }, 'keyup');
    key({ key: 'ArrowLeft' });
    expect(sent.at(-1)).toEqual(['seek-by', { seconds: -10 }]);
  });
});
