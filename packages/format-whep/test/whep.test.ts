// WHEP client (RFC 9725, ADR-008 §8): offer out, answer in (201 + Location), DELETE on destroy;
// a rejected POST, ICE failure and an ICE timeout end as fatal errors.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQoeHook, type OtterError } from '@otter-player/core';
import { createWhepFormat, isWhep } from '@otter-player/format-whep';
import { NO_CAPABILITIES, type Source, type StreamContext } from '@otter-player/media';

type Ice = 'new' | 'checking' | 'connected' | 'failed' | 'closed';

/** What the fake peer does once it has the answer. */
let afterAnswer: Ice = 'connected';
const peers: FakePeer[] = [];

class FakePeer extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: Ice = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  localDescription: { sdp: string } | null = null;
  remote: string | undefined;
  closed = false;
  transceivers: string[] = [];
  readonly config: RTCConfiguration;
  constructor(config: RTCConfiguration) {
    super();
    this.config = config;
    peers.push(this);
  }
  addTransceiver(kind: string, init: { direction: string }) {
    this.transceivers.push(`${kind}:${init.direction}`);
  }
  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'v=0 offer' });
  }
  setLocalDescription(d: { sdp: string }) {
    this.localDescription = { sdp: `${d.sdp}\r\na=candidate:1 1 udp 1 10.0.0.1 5000 typ host` };
    this.iceGatheringState = 'complete';
    return Promise.resolve();
  }
  setRemoteDescription(d: { sdp: string }) {
    this.remote = d.sdp;
    setTimeout(() => this.move(afterAnswer), 1);
    return Promise.resolve();
  }
  move(state: Ice) {
    this.iceConnectionState = state;
    this.dispatchEvent(new Event('iceconnectionstatechange'));
    if (state === 'connected' || state === 'failed') {
      this.connectionState = state;
      this.dispatchEvent(new Event('connectionstatechange'));
    }
  }
  getStats() {
    return Promise.resolve(new Map([['v', { type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 3, jitterBufferEmittedCount: 30 }]]));
  }
  close() {
    this.closed = true;
  }
}

class FakeStream {
  tracks: unknown[] = [];
  addTrack(t: unknown) {
    this.tracks.push(t);
  }
}

const requests: { url: string; init: RequestInit }[] = [];
let respond: () => Response = () => new Response('v=0 answer', { status: 201, headers: { Location: '/whep/session/7' } });

beforeEach(() => {
  peers.length = 0;
  requests.length = 0;
  afterAnswer = 'connected';
  respond = () => new Response('v=0 answer', { status: 201, headers: { Location: '/whep/session/7' } });
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      requests.push({ url, init });
      const res = respond();
      Object.defineProperty(res, 'url', { value: url });
      return Promise.resolve(res);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const ctx = (source: Source): StreamContext => ({ source, options: {}, qoe: createQoeHook(), signal: new AbortController().signal });
const SRC: Source = { src: 'https://cdn.test/rtc/v1/whep/?app=live&stream=a', type: 'application/whep', headers: { Authorization: 'Bearer t' } };

describe('format-whep', () => {
  it('probes WHEP endpoints and feeds the native backend only', () => {
    const f = createWhepFormat();
    expect(f.probe({ src: 'https://x.test/live', type: 'application/whep' }, NO_CAPABILITIES)).toBe(1);
    expect(f.probe({ src: 'https://x.test/rtc/v1/whep/?app=live' }, NO_CAPABILITIES)).toBe(0.9);
    expect(f.probe({ src: 'https://x.test/whep' }, NO_CAPABILITIES)).toBe(0.9);
    expect(f.probe({ src: 'https://x.test/whepstream.m3u8' }, NO_CAPABILITIES)).toBe(0);
    expect(isWhep({ src: new Blob() })).toBe(false);
    expect(f.backends(SRC, NO_CAPABILITIES)).toEqual(['native']);
  });

  it('POSTs the offer, sets the answer, ends the session with DELETE', async () => {
    const session = await createWhepFormat({ iceServers: [{ urls: 'stun:stun.test' }] }).openStream?.(ctx(SRC));
    const pc = peers[0] as FakePeer;
    expect(pc.config.iceServers).toEqual([{ urls: 'stun:stun.test' }]);
    expect(pc.transceivers).toEqual(['video:recvonly', 'audio:recvonly']);
    expect(requests[0]?.url).toBe(SRC.src);
    expect(requests[0]?.init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/sdp', Authorization: 'Bearer t' } });
    // Non-trickle: the offer carries the gathered candidates.
    expect(String(requests[0]?.init.body)).toContain('a=candidate:');
    expect(pc.remote).toBe('v=0 answer');
    expect(session?.stream).toBeInstanceOf(FakeStream);
    session?.destroy();
    expect(pc.closed).toBe(true);
    expect(requests[1]).toMatchObject({ url: 'https://cdn.test/whep/session/7', init: { method: 'DELETE' } });
  });

  it('a rejected POST is a fatal network error (retried by the session), the peer closed', async () => {
    respond = () => new Response('busy', { status: 503 });
    const err = (await createWhepFormat()
      .openStream?.(ctx(SRC))
      .catch((e: unknown) => e)) as OtterError;
    expect(err).toMatchObject({ type: 'network', details: 'whepRejected', fatal: true, recoverable: true });
    expect(peers[0]?.closed).toBe(true);
  });

  it('ICE failure and an ICE timeout are fatal iceFailed errors, not retried', async () => {
    afterAnswer = 'failed';
    const failed = (await createWhepFormat()
      .openStream?.(ctx(SRC))
      .catch((e: unknown) => e)) as OtterError;
    expect(failed).toMatchObject({ type: 'network', details: 'iceFailed', fatal: true, recoverable: false });
    expect(peers[0]?.closed).toBe(true);
    // The server's resource is released even though ICE never connected.
    expect(requests.at(-1)?.init.method).toBe('DELETE');

    afterAnswer = 'checking';
    const timedOut = (await createWhepFormat({ connectTimeoutMs: 20 })
      .openStream?.(ctx(SRC))
      .catch((e: unknown) => e)) as OtterError;
    expect(timedOut).toMatchObject({ details: 'iceFailed', message: 'ICE not connected after 20 ms (checking)' });
  });

  it('reports a failure after the start and the receiver latency', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const session = await createWhepFormat().openStream?.(ctx(SRC));
      const errors: string[] = [];
      session?.onError((e) => void errors.push(e.details));
      expect(session?.latency).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      expect(session?.latency).toBeCloseTo(0.1, 6);
      (peers[0] as FakePeer).move('failed');
      expect(errors).toEqual(['iceFailed']);
      session?.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
