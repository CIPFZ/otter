// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createBackgroundPlayer } from '../src/background.js';
import { PRESET_IDS } from '../src/index.js';
import { buildShell } from '../src/shell.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('background preset (Hero)', () => {
  it('puts a muted, looping, inline, decorative <video> in the container and starts it', () => {
    const box = document.createElement('div');
    document.body.append(box);
    const p = createBackgroundPlayer({ target: box, src: '/hero.mp4', poster: '/hero.jpg' });
    const v = box.querySelector('video') as HTMLVideoElement;
    expect(p.video).toBe(v);
    expect(v.muted && v.loop && v.playsInline).toBe(true);
    expect(v.getAttribute('aria-hidden')).toBe('true');
    expect(v.tabIndex).toBe(-1);
    expect(v.poster).toContain('/hero.jpg');
    expect(v.src).toContain('/hero.mp4');
    expect(p.store.getState()).toMatchObject({ status: 'loading', source: { src: '/hero.mp4' } });
    p.destroy();
    expect(v.hasAttribute('src')).toBe(false);
  });

  it('follows the element into the store and stops following on destroy', () => {
    const video = document.createElement('video');
    const p = createBackgroundPlayer({ target: video, src: '/hero.mp4', loop: false, autoplay: false });
    expect(video.loop).toBe(false);
    Object.defineProperty(video, 'currentTime', { value: 3, configurable: true });
    video.dispatchEvent(new Event('timeupdate'));
    expect(p.store.getState().currentTime).toBe(3);
    p.destroy();
    Object.defineProperty(video, 'currentTime', { value: 4, configurable: true });
    video.dispatchEvent(new Event('timeupdate'));
    expect(p.store.getState().currentTime).toBe(3);
  });
});

describe('shell', () => {
  it('builds the default controls in an empty container and keeps a host shell', () => {
    const box = document.createElement('div');
    const video = buildShell(box, true, 'Title');
    expect(box.hasAttribute('data-otter-player')).toBe(true);
    expect(box.getAttribute('role')).toBe('region');
    expect(box.querySelector('[data-otter-controls] otter-time-slider')).not.toBeNull();
    expect(box.querySelector('[data-otter-title]')?.textContent).toBe('Title');
    expect(video.parentElement).toBe(box);
    const host = document.createElement('div');
    host.innerHTML = '<video id="mine"></video><div class="my-ui"></div>';
    expect(buildShell(host, true, undefined).id).toBe('mine');
    expect(host.querySelector('.my-ui')).not.toBeNull();
    expect(host.querySelector('[data-otter-controls]')).toBeNull();
    const bare = document.createElement('div');
    buildShell(bare, false, undefined);
    expect(bare.children.length).toBe(1);
  });

  it('lists the ten scenario presets (basic and the nine of ADR-013)', () => {
    expect(PRESET_IDS).toHaveLength(10);
    expect(PRESET_IDS[0]).toBe('basic');
  });
});

describe('basic preset', () => {
  it('builds the five controls only, keeps a host shell, and offers fullscreen in the presentation shape', async () => {
    const { createBasicPlayer } = await import('../src/basic.js');
    const box = document.createElement('div');
    document.body.append(box);
    const p = createBasicPlayer({ container: box, idleMs: 0 });
    await p.ready;
    const tags = [...box.querySelectorAll('[data-otter-controls] *')].map((e) => e.localName).filter((n) => n.startsWith('otter-'));
    expect(tags.sort()).toEqual(['otter-fullscreen-button', 'otter-mute-button', 'otter-play-button', 'otter-time-display', 'otter-time-slider']);
    expect(box.getAttribute('role')).toBe('region');
    expect(p.store.getState().presentation.mode).toBe('inline');
    expect(p.explain()).toEqual({ route: null, error: null });
    await p.destroy();
    const host = document.createElement('div');
    host.innerHTML = '<video id="mine"></video>';
    const q = createBasicPlayer({ container: host });
    expect(q.video.id).toBe('mine');
    expect(host.querySelector('[data-otter-controls]')).toBeNull();
    await q.destroy();
  });
});

describe('tv preset keys', () => {
  it('maps the remote media keys and leaves Up / Down to focus moves', async () => {
    const { TV_HOTKEYS } = await import('../src/tv.js');
    expect(TV_HOTKEYS['MediaPlayPause']).toEqual({ type: 'toggle-paused' });
    expect(TV_HOTKEYS['MediaFastForward']).toEqual({ type: 'seek-by', seconds: 10 });
    expect(TV_HOTKEYS['ArrowUp']).toBeUndefined();
    expect(TV_HOTKEYS['ArrowLeft']).toEqual({ type: 'seek-by', seconds: -10 });
  });
});
