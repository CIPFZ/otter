import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineContext } from '@otter-player/media';
import { createMpegtsEngine } from '@otter-player/engine-adapter-mpegts';
import { createPipelineEngine, withAdapterFallback } from '@otter-player/engine-pipeline';
import { createFlvFormat } from '../src/index.js';

vi.mock('@otter-player/engine-adapter-mpegts', () => ({ createMpegtsEngine: vi.fn(() => ({ formatId: 'adapter' })) }));
vi.mock('@otter-player/engine-pipeline', () => ({
  createPipelineEngine: vi.fn(() => ({ formatId: 'own' })),
  withAdapterFallback: vi.fn(() => ({ formatId: 'wrapped' })),
}));
afterEach(() => vi.clearAllMocks());

describe('FLV MSE transport selection', () => {
  it.each(['ws://camera.test/live.flv', 'wss://camera.test/live.flv'])('uses the WebSocket-capable adapter for %s by default', (src) => {
    const context = { source: { src, live: true } } as EngineContext;
    expect(createFlvFormat().createEngine(context)).toEqual({ formatId: 'adapter' });
    expect(createMpegtsEngine).toHaveBeenCalledWith(context, { type: 'flv' });
    expect(createPipelineEngine).not.toHaveBeenCalled();
    expect(withAdapterFallback).not.toHaveBeenCalled();
  });

  it('keeps HTTP on the own pipeline with its adapter fallback', () => {
    const context = { source: { src: 'https://camera.test/live.flv', live: true } } as EngineContext;
    expect(createFlvFormat().createEngine(context)).toEqual({ formatId: 'wrapped' });
    expect(createPipelineEngine).toHaveBeenCalledWith(context, { type: 'flv' });
    expect(withAdapterFallback).toHaveBeenCalled();
  });
});
