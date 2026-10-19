import { describe, expect, it, vi } from 'vitest';
import { createThumbnails, createVttThumbnails } from '@otter-player/overlay-thumbnails';
import type { Source, ThumbnailProvider } from '@otter-player/media';

const VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
sprite.jpg#xywh=0,0,160,90

00:00:02.000 --> 00:00:04.000
sprite.jpg#xywh=160,0,160,90

00:00:04.000 --> 00:00:06.000
https://cdn.example/full.jpg
`;

const serve = (body: string, status = 200) => vi.fn(async () => ({ ok: status === 200, status, text: async () => body }));

describe('WebVTT sprite thumbnails', () => {
  it('maps times to tiles, resolving image URLs against the track', async () => {
    const fetch = serve(VTT);
    const p = createVttThumbnails({ src: 'https://media.example/v/thumbs.vtt', fetch });
    expect(await p.at(2.5)).toEqual({ url: 'https://media.example/v/sprite.jpg', x: 160, y: 0, w: 160, h: 90 });
    expect(await p.at(0)).toEqual({ url: 'https://media.example/v/sprite.jpg', x: 0, y: 0, w: 160, h: 90 });
    // No media fragment: the whole image.
    expect(await p.at(5)).toEqual({ url: 'https://cdn.example/full.jpg', x: 0, y: 0, w: 0, h: 0 });
    expect(await p.at(9)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('a missing track yields no thumbnails, not an error', async () => {
    const p = createVttThumbnails({ src: 'https://media.example/none.vtt', fetch: serve('', 404) });
    expect(await p.at(1)).toBeNull();
  });

  it('createThumbnails prefers the source track and falls back to the engine I-frames', async () => {
    let source: Source | null = { src: 'https://media.example/a.m3u8', thumbnails: { src: 'https://media.example/thumbs.vtt' } };
    const iframes: ThumbnailProvider = { at: vi.fn(async () => null) };
    const p = createThumbnails({ store: { getState: () => ({ source }) }, media: { thumbnails: () => iframes }, fetch: serve(VTT) });
    expect(await p.at(1)).toMatchObject({ x: 0, w: 160 });
    expect(iframes.at).not.toHaveBeenCalled();
    source = { src: 'https://media.example/b.m3u8' };
    await p.at(1);
    expect(iframes.at).toHaveBeenCalledWith(1);
  });
});
