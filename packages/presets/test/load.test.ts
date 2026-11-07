// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_TIME_RANGES, EMPTY_TRACKS, type BackendFactory, type FormatPlugin } from '@otter-player/media';
import { createPlayer, type PlayerOptions } from '../src/player.js';
import { createBasicPlayer } from '../src/basic.js';

afterEach(() => document.body.replaceChildren());

function pendingPlayer(plugins: PlayerOptions['plugins'] = []) {
  const complete: (() => void)[] = [];
  const load = vi.fn(() => new Promise<void>((resolve) => complete.push(resolve)));
  const factory: BackendFactory = {
    kind: 'native',
    create: () => ({
      kind: 'native', attach() {}, load, play: async () => undefined, pause() {}, seek() {},
      setVolume() {}, setMuted() {}, setPlaybackRate() {}, selectQuality() {},
      tracks: EMPTY_TRACKS, buffered: EMPTY_TIME_RANGES,
      on: () => () => undefined, destroy() {},
    }),
  };
  const format: FormatPlugin = {
    id: 'load-fixture', probe: () => 1, backends: () => ['native'],
    createEngine: () => { throw new Error('the fixture backend does not create an engine'); },
  };
  const player = createPlayer({
    container: document.body.appendChild(document.createElement('div')),
    formats: [format], backends: [factory], plugins, ui: false, captions: false,
    presentation: { mediaSession: false, wakeLock: false },
  });
  return { player, load, complete };
}

describe('public load promise', () => {
  it.each(['player', 'basic'] as const)('cancels a %s load destroyed before ready without reporting a media failure', async (kind) => {
    const container = document.body.appendChild(document.createElement('div'));
    const player = kind === 'basic'
      ? createBasicPlayer({ container, ui: false, idleMs: 0 })
      : createPlayer({ container, formats: [], backends: [], ui: false, captions: false, presentation: { mediaSession: false, wakeLock: false } });
    const failed = vi.fn();
    player.qoe.on('error', failed);
    const loading = player.load('custom:cancelled-before-ready').catch((error: unknown) => error);
    await player.destroy();
    expect(await loading).toMatchObject({ name: 'AbortError' });
    expect(failed).not.toHaveBeenCalled();
    expect(player.store.getState()).toMatchObject({ status: 'idle', error: null });
  });

  it('still dispatches one load action to host plugins while awaiting that request', async () => {
    const observed = vi.fn();
    let off: (() => void) | undefined;
    const { player, load, complete } = pendingPlayer([{
      id: 'load-observer',
      install({ store }) { off = store.handle('load', observed); },
      uninstall() { off?.(); },
    }]);
    const pending = player.load('custom:observed', { autoplay: false });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]?.[0]).toMatchObject({ source: { src: 'custom:observed' }, options: { autoplay: false } });
    complete[0]?.();
    await pending;
    await player.destroy();
  });

  it('reports internal shorts load errors in the store while public navigation still rejects', async () => {
    const { createShortsPlayer } = await import('../src/shorts.js');
    const container = document.body.appendChild(document.createElement('div'));
    const player = createShortsPlayer({ container, feed: ['custom:first', 'custom:second', 'custom:third'], ui: false, gestures: false, idleMs: 0 });
    await vi.waitFor(() => expect(player.store.getState().error?.details).toBe('noFormat'));
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await vi.waitFor(() => expect(player.store.getState()).toMatchObject({ status: 'error', source: { src: 'custom:second' } }));
    await expect(player.next()).rejects.toMatchObject({ details: 'noFormat' });
    await player.destroy();
  });

  it('waits for the requested backend to become ready', async () => {
    const { player, load, complete } = pendingPlayer();
    let settled = false;
    const pending = player.load('custom:first').then(() => { settled = true; });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(player.store.getState().status).toBe('loading');
    expect(settled).toBe(false);
    complete[0]?.();
    await pending;
    expect(player.store.getState().status).toBe('ready');
    await player.destroy();
  });

  it.each(['player', 'basic'] as const)('%s rejects with the routing error when no format can load the source', async (kind) => {
    const container = document.body.appendChild(document.createElement('div'));
    const player = kind === 'basic'
      ? createBasicPlayer({ container, ui: false, idleMs: 0 })
      : createPlayer({ container, formats: [], backends: [], ui: false, captions: false, presentation: { mediaSession: false, wakeLock: false } });
    await expect(player.load('custom:no-such-format')).rejects.toMatchObject({ details: 'noFormat' });
    expect(player.store.getState().status).toBe('error');
    await player.destroy();
  });

  it('rejects an older load when replaced and the current load when destroyed', async () => {
    const { player, load } = pendingPlayer();
    const first = player.load('custom:first').catch((error: unknown) => error);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const second = player.load('custom:second').catch((error: unknown) => error);
    expect(await first).toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await player.destroy();
    expect(await second).toMatchObject({ name: 'AbortError' });
  });
});
