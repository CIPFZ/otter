// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bufferedEndAt,
  createCapabilityDetector,
  mediaElementError,
  observeMediaElement,
  seekMedia,
  type BackendEvents,
} from '@otter-player/media';

const ranges = (...r: [number, number][]): TimeRanges => ({
  length: r.length,
  start: (i) => (r[i] as [number, number])[0],
  end: (i) => (r[i] as [number, number])[1],
});

describe('observeMediaElement', () => {
  it('maps element events to backend events and stops listening on destroy', () => {
    const video = document.createElement('video');
    const seen: [keyof BackendEvents, unknown][] = [];
    const observer = observeMediaElement(video, (e, p) => seen.push([e, p]), { now: () => 7 });

    video.dispatchEvent(new Event('waiting'));
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('loadeddata'));
    Object.defineProperty(video, 'muted', { value: true, configurable: true });
    video.dispatchEvent(new Event('volumechange'));

    expect(seen).toContainEqual(['waiting', { position: 0 }]);
    expect(seen.filter(([e]) => e === 'first-frame')).toEqual([['first-frame', { at: 7 }]]);
    expect(seen).toContainEqual(['playback-change', { volume: 1, muted: true }]);
    expect(observer.snapshot()).toMatchObject({ waiting: true, muted: true });

    observer.destroy();
    const before = seen.length;
    video.dispatchEvent(new Event('waiting'));
    expect(seen.length).toBe(before);
  });

  it('computes the buffered end around the playhead', () => {
    expect(bufferedEndAt(ranges([0, 10], [20, 30]), 5)).toBe(10);
    expect(bufferedEndAt(ranges([0, 10], [20, 30]), 15)).toBe(30);
    expect(bufferedEndAt(ranges(), 3)).toBe(0);
  });

  it('maps MediaError codes to the error model', () => {
    expect(mediaElementError({ code: 4, message: '' } as MediaError)).toMatchObject({
      type: 'media',
      details: 'mediaSrcNotSupported',
      fatal: true,
    });
    expect(mediaElementError({ code: 2, message: 'net' } as MediaError)).toMatchObject({ type: 'network' });
    expect(mediaElementError({ code: 3, message: '' } as MediaError)).toMatchObject({ recoverable: true });
  });
});

describe('capability detection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('probes features once and caches codec answers', async () => {
    const isTypeSupported = vi.fn((t: string) => t.includes('avc1'));
    vi.stubGlobal('MediaSource', { isTypeSupported });
    vi.stubGlobal('ManagedMediaSource', undefined);
    const decodingInfo = vi.fn(async () => ({ supported: true, smooth: true, powerEfficient: true }));
    Object.defineProperty(navigator, 'mediaCapabilities', { value: { decodingInfo }, configurable: true });

    const detector = createCapabilityDetector();
    const a = await detector.detect({ codecs: ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="hvc1.1.6.L93.B0"'] });
    await detector.detect({ codecs: ['video/mp4; codecs="avc1.42E01E"'] });

    expect(a.mediaSource).toBe(true);
    expect(a.managedMediaSource).toBe(false);
    expect(a.codecs).toEqual({
      'video/mp4; codecs="avc1.42E01E"': { supported: true, smooth: true, powerEfficient: true },
      // decodingInfo says yes but MSE cannot take it: not supported.
      'video/mp4; codecs="hvc1.1.6.L93.B0"': { supported: false, smooth: true, powerEfficient: true },
    });
    expect(decodingInfo).toHaveBeenCalledTimes(2);
    await detector.detect({ codecs: ['video/mp4; codecs="avc1.42E01E"'], refresh: true });
    expect(decodingInfo).toHaveBeenCalledTimes(3);
  });

  it('falls back to isTypeSupported and answers key systems with a timeout guard', async () => {
    vi.stubGlobal('ManagedMediaSource', { isTypeSupported: () => true });
    vi.stubGlobal('MediaSource', undefined);
    Object.defineProperty(navigator, 'mediaCapabilities', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
      value: (ks: string) => (ks === 'org.w3.clearkey' ? Promise.resolve({}) : Promise.reject(new Error('no'))),
      configurable: true,
    });
    const caps = await createCapabilityDetector().detect({
      codecs: ['video/mp4; codecs="avc1.42E01E"'],
      keySystems: ['org.w3.clearkey', 'com.widevine.alpha'],
    });
    expect(caps).toMatchObject({ mediaSource: false, managedMediaSource: true });
    expect(caps.codecs['video/mp4; codecs="avc1.42E01E"']).toEqual({ supported: true, smooth: true, powerEfficient: false });
    expect(caps.keySystems).toEqual({ 'org.w3.clearkey': true, 'com.widevine.alpha': false });
  });
});

describe('seekMedia (WebKit paused-seek repaint nudge, M6)', () => {
  /** A paused element whose play() moves the time on by a frame. */
  function fakeVideo() {
    const el = new EventTarget() as EventTarget & { currentTime: number; paused: boolean; muted: boolean; play(): Promise<void>; pause(): void; log: string[] };
    let t = 0;
    Object.assign(el, { paused: true, muted: false, log: [] as string[], buffered: ranges() });
    Object.defineProperty(el, 'currentTime', {
      get: () => t,
      set: (v: number) => {
        t = v;
        el.log.push(`seek ${v.toFixed(3)}`);
        queueMicrotask(() => el.dispatchEvent(new Event('seeked')));
      },
    });
    el.play = () => {
      el.log.push(`play muted=${el.muted}`);
      el.paused = false;
      t += 1 / 30;
      el.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    el.pause = () => {
      el.log.push('pause');
      el.paused = true;
      el.dispatchEvent(new Event('pause'));
    };
    return el;
  }
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

  it('on WebKit: plays one frame muted, pauses, seeks back to the exact time; the store sees none of it', async () => {
    vi.stubGlobal('navigator', { userAgent: SAFARI });
    const el = fakeVideo();
    const events: string[] = [];
    observeMediaElement(el as unknown as HTMLMediaElement, (e, p) => events.push(`${e} ${JSON.stringify(p)}`));
    seekMedia(el as unknown as HTMLMediaElement, 0.11);
    await new Promise((r) => setTimeout(r, 10));
    expect(el.log).toEqual(['seek 0.110', 'play muted=true', 'pause', 'seek 0.110']);
    expect(el.muted).toBe(false);
    expect(el.currentTime).toBeCloseTo(0.11, 6);
    // No paused / seeking flicker reached the store: one state snapshot at the end.
    expect(events.filter((e) => e.includes('"paused":false'))).toEqual([]);
    expect(events.at(-1)).toMatch(/^playback-change .*"currentTime":0\.11/);
    vi.unstubAllGlobals();
  });

  it('elsewhere, or while playing: a plain seek', async () => {
    vi.stubGlobal('navigator', { userAgent: CHROME });
    const el = fakeVideo();
    seekMedia(el as unknown as HTMLMediaElement, 0.11);
    await new Promise((r) => setTimeout(r, 10));
    expect(el.log).toEqual(['seek 0.110']);
    vi.unstubAllGlobals();
  });
});
