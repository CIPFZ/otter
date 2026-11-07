import { afterEach, describe, expect, it, vi } from 'vitest';
import { createError } from '@otter-player/core';
import { openHls } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());

describe('HLS opening cancellation', () => {
  it('aborts the pending manifest request and rejects when its owner is cancelled', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    }));
    const owner = new AbortController();
    const outcome = openHls('https://example.test/live.m3u8', { signal: owner.signal, createError }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    owner.abort();
    expect(requestSignal?.aborted).toBe(true);
    expect(await outcome).toMatchObject({ name: 'AbortError' });
  });

  it('does not start a request when the owner was already cancelled', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const owner = new AbortController();
    owner.abort();
    await expect(openHls('https://example.test/live.m3u8', { signal: owner.signal, createError })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
