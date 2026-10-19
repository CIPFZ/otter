// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createCore, type StoreSlice } from '@otter-player/core';
import type { InbandCues, Source, TextTrackInfo } from '@otter-player/media';
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

type S = TextState & { source: Source | null; presentation: { videoOnly: boolean } };
const SOURCE_SLICE: StoreSlice<{ source: Source | null }> = { id: 'source', initialState: { source: null } };
const PRESENTATION_SLICE: StoreSlice<{ presentation: { videoOnly: boolean } }> = { id: 'presentation', initialState: { presentation: { videoOnly: false } } };

async function setup(files: Record<string, string | number>, extra: Partial<Parameters<typeof createText>[0]> = {}) {
  const fetch = vi.fn(async (url: string) => {
    const body = files[url];
    return typeof body === 'string' ? { ok: true, status: 200, text: async () => body } : { ok: false, status: body ?? 404, text: async () => '' };
  });
  const text = createText({ fetch, persistKey: null, ...extra });
  const core = createCore<S, TextActionMap>({ slices: [TEXT_SLICE, SOURCE_SLICE, PRESENTATION_SLICE], plugins: [text.plugin] });
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
    // 8% of the picture stays free at the bottom (UI-DESIGN §9).
    expect(layer?.style.height).toBe('441.6px');
    // A 64 px bar over the picture: 8% + 64 px + 8 px.
    text.overlay.setSafeArea?.({ top: 0, right: 0, bottom: 64, left: 0 });
    expect(layer?.style.height).toBe('369.6px');
    core.store.dispatch('toggle-captions', {});
    expect(root.querySelector('[data-cue-id]')).toBeNull();
    text.overlay.destroy();
    expect(root.querySelector('[data-otter-cues]')).toBeNull();
  });

  it('video-only presentation mirrors the selected track into a native TextTrack, and back', async () => {
    class FakeCue {
      line: number | 'auto' = 'auto';
      position: number | 'auto' = 'auto';
      size = 100;
      snapToLines = true;
      align = 'center';
      readonly startTime: number;
      readonly endTime: number;
      readonly text: string;
      constructor(startTime: number, endTime: number, text: string) {
        this.startTime = startTime;
        this.endTime = endTime;
        this.text = text;
      }
    }
    vi.stubGlobal('VTTCue', FakeCue);
    const track = { mode: 'disabled' as TextTrackMode, cues: [] as FakeCue[], addCue: (c: FakeCue) => void track.cues.push(c), removeCue: vi.fn() };
    const addTextTrack = vi.fn(() => track as unknown as TextTrack);
    const { core, text } = await setup({ '/en.vtt': VTT }, { native: { addTextTrack } });
    core.store.setState({ source: { src: '/a.mp4', textTracks: [{ src: '/en.vtt', language: 'en', label: 'English', default: true }] } });
    await flush();
    await flush();
    const root = document.createElement('div');
    document.body.appendChild(root);
    text.overlay.mount({ root, contentRect: new DOMRect(0, 0, 640, 360), safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, store: core.store.view(), onContentRectChange: () => () => undefined });
    text.overlay.tick?.(0, 2);
    expect(root.querySelector('[data-cue-id]')?.textContent).toBe('Hello');
    expect(addTextTrack).not.toHaveBeenCalled();
    // Video PiP / iPhone system fullscreen: the system draws the captions.
    core.store.setState({ presentation: { videoOnly: true } });
    await vi.waitFor(() => expect(track.mode).toBe('showing'));
    expect(addTextTrack).toHaveBeenCalledWith('subtitles', 'English', 'en');
    expect(track.cues.map((c) => [c.startTime, c.endTime, c.text])).toEqual([[1, 4, 'Hello']]);
    text.overlay.tick?.(0, 2);
    expect(root.querySelector('[data-cue-id]')).toBeNull();
    core.store.setState({ presentation: { videoOnly: false } });
    expect(track.mode).toBe('hidden');
    text.overlay.tick?.(0, 2);
    expect(root.querySelector('[data-cue-id]')?.textContent).toBe('Hello');
    text.overlay.destroy();
    vi.unstubAllGlobals();
  });

  it('offers engine tracks, tells the media plugin which one to deliver and renders its cues', async () => {
    let deliver: ((c: InbandCues) => void) | undefined;
    const text = createText({ persistKey: null, inband: { onTextCues: (h) => ((deliver = h), () => undefined) } });
    type HS = S & { tracks: { text: TextTrackInfo[] } };
    const TRACKS: StoreSlice<{ tracks: { text: TextTrackInfo[] } }> = { id: 'tracks', initialState: { tracks: { text: [] } } };
    const core = createCore<HS, TextActionMap>({ slices: [TEXT_SLICE, SOURCE_SLICE, TRACKS], plugins: [text.plugin] });
    const engineSelection: (string | null)[] = [];
    await core.start();
    core.store.handle('set-text-track', ({ id }) => void engineSelection.push(id));
    core.store.setState({ tracks: { text: [{ kind: 'text', id: 'text-0', role: 'subtitles', format: 'vtt', language: 'en', selected: false }] } });
    expect(core.store.getState().textTracks).toEqual([{ id: 'inband:text-0', source: 'inband', role: 'subtitles', format: 'vtt', language: 'en' }]);
    core.store.dispatch('select-text-track', { id: 'inband:text-0' });
    expect(engineSelection).toEqual(['text-0']);
    expect(core.store.getState().textStatus).toBe('ready');
    deliver?.({ trackId: 'text-0', cues: [{ id: 'a', startTime: 1, endTime: 2, text: '<i>Hi</i> there', line: 0 }] });
    deliver?.({ trackId: 'text-0', cues: [{ id: 'a', startTime: 1, endTime: 2, text: '<i>Hi</i> there', line: 0 }] });
    await vi.waitFor(() => expect(text.cues('inband:text-0')).toHaveLength(1));
    const [c] = text.cues('inband:text-0');
    expect(c?.settings.line).toBe(0);
    expect(c?.nodes[0]).toMatchObject({ type: 'i' });
    // The track disappears (new engine, new manifest): selection falls back to off.
    core.store.setState({ tracks: { text: [] } });
    expect(core.store.getState()).toMatchObject({ textTracks: [], textTrack: null });
    expect(engineSelection.at(-1)).toBeNull();
  });

  it('caption style (CVAA): applied to the cue layer, retained with the caption language', async () => {
    localStorage.clear();
    const make = async () => {
      const text = createText({ fetch: async () => ({ ok: true, status: 200, text: async () => VTT }) });
      const core = createCore<S, TextActionMap>({ slices: [TEXT_SLICE, SOURCE_SLICE], plugins: [text.plugin] });
      await core.start();
      return { core, text };
    };
    const first = await make();
    first.core.store.setState({ source: { src: '/a.mp4', textTracks: [{ src: '/en.vtt', language: 'en' }, { src: '/fr.vtt', language: 'fr' }] } });
    first.core.store.dispatch('select-text-track', { id: 'sidecar:1' });
    first.core.store.dispatch('set-caption-style', { scale: 2, color: '#ffff00', edge: 'outline' });
    first.core.store.dispatch('set-caption-style', { color: null });
    // Caption window (CVAA): behind all lines of the cue, default colour black.
    first.core.store.dispatch('set-caption-style', { windowOpacity: 0.5 });
    expect(first.core.store.getState().captionStyle).toEqual({ scale: 2, edge: 'outline', windowOpacity: 0.5 });

    const root = document.createElement('div');
    document.body.appendChild(root);
    first.text.overlay.mount({ root, contentRect: new DOMRect(0, 0, 640, 360), safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, store: first.core.store.view(), onContentRectChange: () => () => undefined });
    const layer = root.querySelector<HTMLElement>('[data-otter-cues]');
    expect(layer?.style.getPropertyValue('--otter-cue-user-scale')).toBe('2');
    expect(layer?.style.getPropertyValue('--otter-cue-user-shadow')).toContain('#000');
    expect(layer?.style.getPropertyValue('--otter-cue-user-color')).toBe('');
    expect(layer?.style.getPropertyValue('--otter-cue-user-window')).toMatch(/^rgb\(0 0 0 \/ 0\.5\)$|^#00000080$|^rgba\(0, 0, 0, 0\.5\)$/);

    // Next visit: same style, and French chosen again although the host marks English default.
    const second = await make();
    expect(second.core.store.getState().captionStyle).toEqual({ scale: 2, edge: 'outline', windowOpacity: 0.5 });
    second.core.store.setState({ source: { src: '/b.mp4', textTracks: [{ src: '/en.vtt', language: 'en', default: true }, { src: '/fr.vtt', language: 'fr' }] } });
    expect(second.core.store.getState().textTrack).toBe('sidecar:1');
    // Turning captions off is remembered too.
    second.core.store.dispatch('select-text-track', { id: null });
    const third = await make();
    third.core.store.setState({ source: { src: '/c.mp4', textTracks: [{ src: '/en.vtt', language: 'en', default: true }] } });
    expect(third.core.store.getState().textTrack).toBeNull();
    localStorage.clear();
  });
});
