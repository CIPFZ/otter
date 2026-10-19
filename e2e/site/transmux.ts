// Feeds the own pipeline's fMP4 output into MSE directly (no engine, no session), so a browser
// proves the bytes decode and play (ADR-007 §2). Driven by e2e/transmux.spec.ts.

import { createFlvTransmuxer, createTsTransmuxer, type TransmuxResult } from '@otter-player/pipeline/transmux';

export interface TransmuxPlayResult {
  readonly mimeTypes: string[];
  readonly supported: boolean[];
  readonly buffered: [number, number][];
  readonly errors: string[];
  readonly played: number;
  readonly decoded: number;
}

declare global {
  interface Window {
    transmuxPlay?: (url: string, kind: 'flv' | 'ts', chunk: number) => Promise<TransmuxPlayResult>;
  }
}

const MS = (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? MediaSource;

window.transmuxPlay = async (url, kind, chunk) => {
  const video = document.querySelector('video') as HTMLVideoElement;
  const t = kind === 'flv' ? createFlvTransmuxer() : createTsTransmuxer();
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const results: TransmuxResult[] = [];
  for (let o = 0; o < bytes.byteLength; o += chunk) results.push(t.push(bytes.subarray(o, o + chunk)));
  results.push(t.flush());
  const init = results.flatMap((r) => r.init);
  const fragments = results.flatMap((r) => r.fragments);

  const ms = new MS();
  video.disableRemotePlayback = true;
  video.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const buffers = new Map<string, SourceBuffer>();
  for (const i of init) buffers.set(i.type, ms.addSourceBuffer(i.mimeType));
  const append = (sb: SourceBuffer, data: Uint8Array): Promise<void> =>
    new Promise((resolve, reject) => {
      sb.addEventListener('updateend', () => resolve(), { once: true });
      sb.addEventListener('error', () => reject(new Error('append error')), { once: true });
      sb.appendBuffer(data as BufferSource);
    });
  for (const i of init) await append(buffers.get(i.type) as SourceBuffer, i.data);
  for (const f of fragments) await append(buffers.get(f.type) as SourceBuffer, f.data);
  ms.endOfStream();
  const start = video.buffered.length > 0 ? video.buffered.start(0) : 0;
  video.currentTime = start;
  await video.play();
  await new Promise((r) => setTimeout(r, 3000));
  const buffered: [number, number][] = [];
  for (let i = 0; i < video.buffered.length; i++) buffered.push([video.buffered.start(i), video.buffered.end(i)]);
  return {
    mimeTypes: init.map((i) => i.mimeType),
    supported: init.map((i) => MS.isTypeSupported(i.mimeType)),
    buffered,
    errors: t.errors.map((e) => `${e.details}: ${e.message}`),
    played: video.currentTime - start,
    decoded: video.getVideoPlaybackQuality().totalVideoFrames,
  };
};
