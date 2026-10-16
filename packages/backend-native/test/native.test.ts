// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createQoeHook } from '@otter-player/core';
import { createNativeBackend, readNativeTracks } from '@otter-player/backend-native';
import { NO_CAPABILITIES, type FormatPlugin } from '@otter-player/media';

const format = { id: 'mp4-range' } as FormatPlugin;
const ctx = { format, step: { backend: 'native' as const }, caps: NO_CAPABILITIES, qoe: createQoeHook() };

describe('createNativeBackend', () => {
  it('sets src, resolves on loadedmetadata and applies the start time', async () => {
    const backend = createNativeBackend(ctx);
    const video = document.createElement('video');
    backend.attach(video);
    const loaded = backend.load({ src: 'https://e.test/a.mp4' }, { startTime: 5 });
    expect(video.getAttribute('src')).toBe('https://e.test/a.mp4');
    video.dispatchEvent(new Event('loadedmetadata'));
    await loaded;
    expect(video.currentTime).toBe(5);
    expect(backend.tracks.quality).toBe('opaque');
    backend.destroy();
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('rejects with the mapped element error', async () => {
    const backend = createNativeBackend(ctx);
    const video = document.createElement('video');
    backend.attach(video);
    const loaded = backend.load({ src: 'https://e.test/missing.mp4' }, {});
    Object.defineProperty(video, 'error', { value: { code: 4, message: 'unsupported' }, configurable: true });
    video.dispatchEvent(new Event('error'));
    await expect(loaded).rejects.toMatchObject({ details: 'mediaSrcNotSupported', fatal: true });
  });

  it('plays Blob sources through an object URL', async () => {
    const backend = createNativeBackend(ctx, { disableRemotePlayback: true });
    const video = document.createElement('video');
    backend.attach(video);
    const loaded = backend.load({ src: new Blob(['x'], { type: 'video/mp4' }) }, {});
    expect(video.getAttribute('src')).toMatch(/^blob:/);
    expect(video.disableRemotePlayback).toBe(true);
    video.dispatchEvent(new Event('loadedmetadata'));
    await loaded;
    backend.destroy();
  });

  it('rejects non-media targets', () => {
    expect(() => createNativeBackend(ctx).attach(document.createElement('canvas'))).toThrow(
      expect.objectContaining({ details: 'unsupportedTarget' }),
    );
  });

  it('reads native text tracks', () => {
    const video = document.createElement('video');
    expect(readNativeTracks(video)).toMatchObject({ video: [], audio: [], text: [], quality: 'opaque' });
  });
});
