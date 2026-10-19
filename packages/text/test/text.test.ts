// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createCore, type StoreSlice } from '@otter-player/core';
import type { Source } from '@otter-player/media';
import type { OverlayHost } from '@otter-player/surface';
import { createCueRenderer, createText, TEXT_SLICE, type TextActionMap, type TextState } from '@otter-player/text';
import { parseCaptions } from '../src/vtt.js';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createCueRenderer', () => {
  it('builds cue DOM from text nodes only (no markup injection)', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const r = createCueRenderer(root);
    const { cues } = await parseCaptions('WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n<b>Hi</b> &lt;img src=x onerror="window.pwned=1"&gt;\n');
    r.render(cues, { left: 0, top: 60, width: 640, height: 360 }, 1);
    const box = root.querySelector('[data-cue-id]');
    expect(box?.querySelector('b')?.textContent).toBe('Hi');
    expect(box?.querySelector('img')).toBeNull();
    expect(box?.textContent).toContain('<img src=x');
    // The cue layer sits on the given area (the picture), not the container.
    const layer = root.querySelector<HTMLElement>('[data-otter-cues]');
    expect(layer?.style.top).toBe('60px');
    expect(layer?.style.height).toBe('360px');
    r.render([], { left: 0, top: 60, width: 640, height: 360 }, 6);
    expect(root.querySelector('[data-cue-id]')).toBeNull();
    r.destroy();
  });
});

type S = TextState & { source: Source | null };
const SOURCE_SLICE: StoreSlice<{ source: Source | null }> = { id: 'source', initialState: { source: null } };

async function setup(files: Record<string, string | number>) {
  const fetch = vi.fn(async (url: string) => {
    const body = files[url];
    return typeof body === 'string' ? { ok: true, status: 200, text: async () => body } : { ok: false, status: body ?? 404, text: async () => '' };
  });
  const text = createText({ fetch });
  const core = createCore<S, TextActionMap>({ slices: [TEXT_SLICE, SOURCE_SLICE], plugins: [text.plugin] });
  const errors: string[] = [];
  core.qoe.on('error', ({ error }) => errors.push(error.details));
  await core.start();
  return { core, text, fetch, errors };
}

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello\n';

describe('text plugin', () => {
  it('lists the source sidecar tracks and selects the default one', async () => {
    const { core, text, fetch } = await setup({ '/en.vtt': VTT, '/zh.srt': '1\n00:00:01,000 --> 00:00:02,000\n你好\n' });
    core.store.setState({
      source: { src: '/a.m3u8', textTracks: [{ src: '/en.vtt', language: 'en', label: 'English' }, { src: '/zh.srt', language: 'zh', default: true }] },
    });
    expect(core.store.getState().textTracks).toEqual([
      { id: 'sidecar:0', source: 'sidecar', role: 'subtitles', format: 'vtt', language: 'en', label: 'English' },
      { id: 'sidecar:1', source: 'sidecar', role: 'subtitles', format: 'srt', language: 'zh' },
    ]);
    expect(core.store.getState()).toMatchObject({ textTrack: 'sidecar:1', textStatus: 'loading' });
    await flush();
    await flush();
    expect(core.store.getState().textStatus).toBe('ready');
    expect(text.cues('sidecar:1')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('toggle-captions turns captions off and back on to the last track', async () => {
    const { core } = await setup({ '/en.vtt': VTT, '/fr.vtt': VTT });
    core.store.setState({ source: { src: '/a.mp4', textTracks: [{ src: '/en.vtt' }, { src: '/fr.vtt' }] } });
    expect(core.store.getState().textTrack).toBeNull();
    core.store.dispatch('toggle-captions', {});
    expect(core.store.getState().textTrack).toBe('sidecar:0');
    core.store.dispatch('select-text-track', { id: 'sidecar:1' });
    core.store.dispatch('toggle-captions', {});
    expect(core.store.getState().textTrack).toBeNull();
    core.store.dispatch('toggle-captions', {});
    expect(core.store.getState().textTrack).toBe('sidecar:1');
    core.store.dispatch('select-text-track', { id: 'nope' });
    expect(core.store.getState().textTrack).toBe('sidecar:1');
  });

  it('a failing subtitle file is a non-fatal QoE error', async () => {
    const { core, errors } = await setup({ '/en.vtt': 404 });
    core.store.setState({ source: { src: '/a.mp4', textTracks: [{ src: '/en.vtt', default: true }] } });
    await flush();
    expect(core.store.getState().textStatus).toBe('error');
    expect(errors).toEqual(['textTrackLoadFailed']);
  });

  it('overlay draws active cues on the picture, above the safe area', async () => {
    const { core, text } = await setup({ '/en.vtt': VTT });
    core.store.setState({ source: { src: '/a.mp4', textTracks: [{ src: '/en.vtt', default: true }] } });
    await flush();
    await flush();
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { value: 640 });
    Object.defineProperty(root, 'clientHeight', { value: 480 });
    document.body.appendChild(root);
    const host: OverlayHost = {
      root,
      contentRect: new DOMRect(0, 0, 640, 480),
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      store: core.store.view(),
      onContentRectChange: () => () => undefined,
    };
    text.overlay.mount(host);
    text.overlay.tick?.(0, 0.5);
    expect(root.querySelector('[data-cue-id]')).toBeNull();
    text.overlay.tick?.(0, 2);
    expect(root.querySelector('[data-cue-id]')?.textContent).toBe('Hello');
    const layer = root.querySelector<HTMLElement>('[data-otter-cues]');
    expect(layer?.style.height).toBe('480px');
    text.overlay.setSafeArea?.({ top: 0, right: 0, bottom: 64, left: 0 });
    expect(layer?.style.height).toBe('416px');
    core.store.dispatch('toggle-captions', {});
    expect(root.querySelector('[data-cue-id]')).toBeNull();
    text.overlay.destroy();
    expect(root.querySelector('[data-otter-cues]')).toBeNull();
  });
});
