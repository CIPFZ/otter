// WHEP session (RFC 9725): one RTCPeerConnection, recvonly, non-trickle. Loaded with the first
// WHEP source (format-whep's on-demand chunk).

import { createError, createEventBus, type OtterError } from '@otter-player/core';
import type { StreamContext, StreamSession } from '@otter-player/media';
import type { WhepFormatOptions } from './index.js';

const STATE_EVENTS = ['connectionstatechange', 'iceconnectionstatechange'] as const;

const iceFailed = (message: string): OtterError => createError({ type: 'network', details: 'iceFailed', fatal: true, recoverable: false, message });

/** Resolves when gathering is complete or after `ms` (the offer then carries what there is). */
const gathered = (pc: RTCPeerConnection, ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = (): void => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });

/** Resolves once connected; rejects with `iceFailed` on failure or after `ms`. */
const connected = (pc: RTCPeerConnection, ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const done = (err?: OtterError): void => {
      clearTimeout(timer);
      for (const t of STATE_EVENTS) pc.removeEventListener(t, check);
      signal.removeEventListener('abort', abort);
      if (err === undefined) resolve();
      else reject(err);
    };
    // Both events: headless Firefox ended the wait only through iceconnectionstatechange (RESEARCH §1).
    const check = (): void => {
      if (pc.connectionState === 'connected') done();
      else if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') done(iceFailed('ICE failed: no candidate pair connected'));
    };
    const abort = (): void => done(createError({ type: 'other', details: 'loadAborted', fatal: false, recoverable: true }));
    const timer = setTimeout(() => done(iceFailed(`ICE not connected after ${ms} ms (${pc.iceConnectionState})`)), ms);
    for (const t of STATE_EVENTS) pc.addEventListener(t, check);
    signal.addEventListener('abort', abort);
    check();
  });

/** Capture-to-display estimate from the video receiver's jitter buffer, seconds. */
async function measureLatency(pc: RTCPeerConnection): Promise<number | undefined> {
  const stats = await pc.getStats();
  let latency: number | undefined;
  stats.forEach((s: { type?: string; kind?: string; jitterBufferDelay?: number; jitterBufferEmittedCount?: number }) => {
    if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
    if (s.jitterBufferDelay !== undefined && (s.jitterBufferEmittedCount ?? 0) > 0) latency = s.jitterBufferDelay / (s.jitterBufferEmittedCount as number);
  });
  return latency;
}

export async function connectWhep(ctx: StreamContext, options: WhepFormatOptions): Promise<StreamSession> {
  const endpoint = ctx.source.src;
  if (typeof endpoint !== 'string') throw createError({ type: 'media', details: 'unsupportedSource', fatal: true, recoverable: false, message: 'WHEP needs an endpoint URL' });
  const pc = new RTCPeerConnection({ iceServers: [...(options.iceServers ?? [])] });
  const stream = new MediaStream();
  const bus = createEventBus<{ error: OtterError }>();
  let resource: string | undefined;
  let latency: number | undefined;
  let statsTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (statsTimer !== undefined) clearInterval(statsTimer);
    pc.close();
    // Ends the session on the server (WHEP DELETE); nobody waits for it.
    if (resource !== undefined) void fetch(resource, { method: 'DELETE', keepalive: true, headers: { ...ctx.source.headers } }).catch(() => undefined);
    bus.clear();
  };

  try {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addEventListener('track', (e) => stream.addTrack(e.track));
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, options.gatherTimeoutMs ?? 1500);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', ...ctx.source.headers },
        body: pc.localDescription?.sdp ?? '',
        signal: ctx.signal,
      });
    } catch (err) {
      throw createError({ type: 'network', details: 'whepRequestFailed', fatal: true, recoverable: true, message: String(err), cause: err });
    }
    if (res.status !== 201 && !res.ok) {
      throw createError({ type: 'network', details: 'whepRejected', fatal: true, recoverable: true, message: `WHEP endpoint answered ${res.status}` });
    }
    const location = res.headers.get('Location');
    if (location !== null) resource = new URL(location, res.url || endpoint).href;
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    await connected(pc, options.connectTimeoutMs ?? 8000, ctx.signal);
  } catch (err) {
    close();
    throw err;
  }

  // After the start: a connection that fails for good ends playback (fallback chain).
  let failed = false;
  const failedLater = (): void => {
    if (failed || closed || (pc.connectionState !== 'failed' && pc.iceConnectionState !== 'failed')) return;
    failed = true;
    bus.emit('error', iceFailed('ICE failed during playback'));
  };
  for (const t of STATE_EVENTS) pc.addEventListener(t, failedLater);
  statsTimer = setInterval(() => {
    measureLatency(pc).then(
      (l) => (latency = l),
      () => undefined,
    );
  }, 1000);

  return {
    stream,
    get latency() {
      return latency;
    },
    onError: (h) => bus.on('error', h),
    destroy: close,
  };
}
