// cn-live over WebRTC (SPEC §19 国内直播, ADR-008 §8): format-whep against the local WHEP endpoint
// (e2e/whep.ts, a werift peer sending a looped VP8 clip). The MediaStream plays on the native
// backend; ICE that cannot connect goes down the fallback chain to the source's fallback (the
// local HTTP-FLV live stream).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const state = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const s = o.state();
    return {
      status: s.status,
      t: s.currentTime,
      paused: s.paused,
      backend: s.backend,
      format: s.format,
      latency: s.latency,
      width: (document.querySelector('video') as HTMLVideoElement).videoWidth,
      errors: o.events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string } }).error.details),
      steps: s.route?.steps.map((r) => `${r.candidate} ${r.outcome} ${r.reason}`) ?? [],
    };
  });

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

/**
 * Whether this browser gathers any ICE candidate at all. Headless Firefox in some containers does
 * not (gathering stays `new`, "ICE failed" before any answer); nothing to test there.
 */
const gathers = (page: Page): Promise<boolean> =>
  page.evaluate(async () => {
    const pc = new RTCPeerConnection();
    let any = false;
    // Candidate events, not the SDP: real Firefox (Windows) gathers but its localDescription read
    // here did not list them.
    pc.onicecandidate = (e) => (any ||= e.candidate !== null && e.candidate.candidate !== '');
    pc.addTransceiver('video', { direction: 'recvonly' });
    await pc.setLocalDescription(await pc.createOffer());
    for (let i = 0; i < 30 && !any; i++) await new Promise((r) => setTimeout(r, 100));
    pc.close();
    return any;
  });

/**
 * Firefox under automation does not start ICE gathering on a document loaded straight from the
 * local server (gathering stays `new`; data: URLs and documents fulfilled through Playwright's
 * routing gather at once, RESEARCH §1): its documents go through routing here. Its host
 * candidates are mDNS names the werift fixture cannot resolve, so the Firefox projects turn
 * obfuscation off (playwright.config.ts).
 */
async function routeDocuments(page: Page, browserName: string): Promise<void> {
  if (browserName === 'firefox') await page.route('**/*', async (r) => (r.request().resourceType() === 'document' ? r.fulfill({ response: await r.fetch() }) : r.fallback()));
}

async function load(page: Page, source: object, query = ''): Promise<void> {
  await page.goto(`/player.html?idle=0${query}`);
  await page.evaluate(async (src) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load(src as Parameters<OtterFixture['load']>[0], { autoplay: true });
  }, source);
}

test('cn-live WHEP: the WebRTC stream plays on the native backend', async ({ page, browserName }) => {
  test.setTimeout(60_000);
  await routeDocuments(page, browserName);
  await page.goto('/player.html?idle=0');
  if (!(await gathers(page))) {
    ciNotice('WHEP: this browser gathers no ICE candidates here; WebRTC playback not testable');
    test.skip(true, 'no ICE candidates here');
  }
  await load(page, { src: '/whep/live', type: 'application/whep', live: true });
  await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(1);
  const s = await state(page);
  expect(s).toMatchObject({ status: 'ready', paused: false, backend: 'native', format: 'whep', width: 320, errors: [] });
  // New pictures keep arriving (25 fps source).
  const frames = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const v = document.querySelector('video') as HTMLVideoElement;
        let n = 0;
        const count = (): void => {
          n++;
          v.requestVideoFrameCallback(count);
        };
        v.requestVideoFrameCallback(count);
        setTimeout(() => resolve(n), 1000);
      }),
  );
  expect(frames).toBeGreaterThan(10);
  // Sub-second: the receiver's jitter buffer, from WebRTC stats.
  await expect.poll(async () => (await state(page)).latency, { timeout: 5000 }).not.toBeNull();
  expect((await state(page)).latency as number).toBeLessThan(1);
  // The audio track (Opus, 440 Hz tone) arrives and carries sound: RMS of the received stream
  // through an AnalyserNode (the player is muted; the stream itself is not).
  const audio = await page.evaluate(async () => {
    const stream = (document.querySelector('video') as HTMLVideoElement).srcObject as MediaStream;
    const tracks = stream.getAudioTracks().length;
    const ctx = new AudioContext();
    const running = await Promise.race([ctx.resume().then(() => ctx.state === 'running'), new Promise<boolean>((r) => setTimeout(() => r(false), 1000))]);
    if (!running || tracks === 0) return { tracks, running, rms: 0 };
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let rms = 0;
    for (let i = 0; i < 20 && rms < 0.01; i++) {
      await new Promise((r) => setTimeout(r, 100));
      analyser.getFloatTimeDomainData(data);
      rms = Math.sqrt(data.reduce((a, x) => a + x * x, 0) / data.length);
    }
    void ctx.close();
    return { tracks, running, rms };
  });
  expect(audio.tracks).toBe(1);
  if (audio.running) expect(audio.rms).toBeGreaterThan(0.01);
  ciNotice(`WHEP: video ${frames} frames/s, audio track ${audio.running ? `RMS ${audio.rms.toFixed(3)}` : '(no running AudioContext to measure it)'}`);
});

test('cn-live WHEP: ICE that cannot connect falls back to the HTTP-FLV source', async ({ page, browserName }) => {
  test.setTimeout(60_000);
  await routeDocuments(page, browserName);
  await load(page, { src: '/whep/ice-fail', type: 'application/whep', live: true, fallback: { src: '/live/stream.flv', live: true } }, '&ice=2000');
  await expect.poll(async () => (await state(page)).format, { timeout: 20_000 }).toBe('flv');
  await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(0.5);
  const s = await state(page);
  expect(s).toMatchObject({ status: 'ready', paused: false });
  // No retry of the same offer: one iceFailed, straight to the fallback source.
  expect(s.errors).toEqual(['iceFailed']);
  expect(s.steps.some((r) => r === 'source fallback selected format flv')).toBe(true);
});

/** Loop length of the WHEP fixture's audio (e2e/media/whep/tone.ogg: 201 packets of 20 ms). */
const LOOP_S = 4.02;

/** A 16-bit mono PCM WAV file. */
function wav(samples: Int16Array, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + samples.byteLength, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

/** Share of a window's energy at `f` Hz (Goertzel; 1 for a pure tone at f). */
function toneShare(x: Float64Array, from: number, n: number, f: number, rate: number): number {
  const w = (2 * Math.PI * f) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  let energy = 0;
  for (let i = from; i < from + n; i++) {
    const v = x[i] as number;
    const s0 = v + c * s1 - s2;
    s2 = s1;
    s1 = s0;
    energy += v * v;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  return energy === 0 ? 0 : (2 * power) / (n * energy);
}

// The WHEP audio as heard by the page (test round decision 3b, 2026-10-28): 20 s of the received
// track recorded through WebAudio, written as WAV (test-results/, attached to the report), and
// read back: a 440 Hz tone in every second, and the 4 s loop seam of the source (e2e/whep.ts loops
// the 4 s tone.ogg). It proves what the page received and decoded, not the system output.
test('cn-live WHEP recording: 20 s of the received audio, a 440 Hz tone with the loop seam every 4 s @solo', async ({ page, browserName }, info) => {
  test.setTimeout(90_000);
  // Known flaky on WebKit (owner 2026-10-29, RESEARCH §1): now and then the recorded tone is
  // 463.6 Hz with seams 3.83 s apart (x 1.054 both: the recording path's sample rate, not the
  // playback); the criterion stays, the notice carries the measured tone and seams.
  if (browserName === 'webkit') info.annotations.push({ type: 'flaky', description: 'WebKit: recording path pitched x1.054 in 1 of 2 CI runs' });
  await routeDocuments(page, browserName);
  await page.goto('/player.html?idle=0');
  if (!(await gathers(page))) {
    ciNotice('WHEP recording: this browser gathers no ICE candidates here; not testable');
    test.skip(true, 'no ICE candidates here');
  }
  await load(page, { src: '/whep/live', type: 'application/whep', live: true });
  await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(1);
  const rec = await page.evaluate(async (seconds) => {
    const stream = (document.querySelector('video') as HTMLVideoElement).srcObject as MediaStream;
    if (stream.getAudioTracks().length === 0) return { running: true, tracks: 0, rate: 0, b64: '', got: 0, messages: 0, calls: 0, empty: 0 };
    const ctx = new AudioContext();
    const running = await Promise.race([ctx.resume().then(() => ctx.state === 'running'), new Promise<boolean>((r) => setTimeout(() => r(false), 1000))]);
    if (!running) return { running, tracks: 1, rate: 0, b64: '', got: 0, messages: 0, calls: 0, empty: 0 };
    // Batches of 0.1 s; `calls` and `empty` (process() without an input channel) for a failure.
    const code = `registerProcessor('otter-rec', class extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(4800); this.n = 0; this.calls = 0; this.empty = 0; }
      process(inputs) {
        this.calls++;
        const ch = inputs[0] && inputs[0][0];
        if (!ch) { this.empty++; return true; }
        for (let i = 0; i < ch.length; i++) {
          this.buf[this.n++] = ch[i];
          if (this.n === this.buf.length) { this.port.postMessage({ s: this.buf, calls: this.calls, empty: this.empty }); this.buf = new Float32Array(4800); this.n = 0; }
        }
        return true;
      }
    });`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const node = new AudioWorkletNode(ctx, 'otter-rec');
    const want = Math.round(seconds * ctx.sampleRate);
    const out = new Int16Array(want);
    let n = 0;
    let messages = 0;
    let calls = 0;
    let empty = 0;
    await new Promise<void>((resolve) => {
      // At most 10 s more than the recording: what arrived by then is reported.
      setTimeout(resolve, (seconds + 10) * 1000);
      node.port.onmessage = (e: MessageEvent<{ s: Float32Array; calls: number; empty: number }>) => {
        messages++;
        ({ calls, empty } = e.data);
        for (const v of e.data.s) {
          if (n >= want) break;
          out[n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        }
        if (n >= want) resolve();
      };
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(ctx.destination);
    });
    const rate = ctx.sampleRate;
    void ctx.close();
    const bytes = new Uint8Array(out.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { running, tracks: 1, rate, b64: btoa(bin), got: n, messages, calls, empty };
  }, 20);
  expect(rec.tracks).toBe(1);
  if (!rec.running) {
    ciNotice('WHEP recording: no running AudioContext here, nothing to record');
    test.skip(true, 'no running AudioContext');
  }
  expect(rec.got, `${rec.got} of ${20 * rec.rate} samples within 30 s (${rec.messages} batches of 0.1 s; process() ran ${rec.calls} times, ${rec.empty} without input)`).toBe(20 * rec.rate);
  const buf = Buffer.from(rec.b64, 'base64');
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const file = `test-results/whep-recording-${info.project.name}.wav`;
  mkdirSync('test-results', { recursive: true });
  writeFileSync(file, wav(pcm, rec.rate));
  await info.attach('whep-recording.wav', { path: file, contentType: 'audio/wav' });

  const x = Float64Array.from(pcm, (v) => v / 32768);
  const rate = rec.rate;
  // The tone's frequency: the strongest of 400-480 Hz over the whole recording (the received clock
  // may differ from the source's by a fraction of a hertz; WebKit's recording path now and then by
  // x1.054, which the notice then shows).
  let f0 = 440;
  let best = 0;
  // Coarse on one second (1 Hz wide peaks), fine on the whole recording.
  const from = Math.min(2 * rate, Math.max(0, x.length - rate));
  for (let f = 400; f <= 480; f += 0.5) {
    const share = toneShare(x, from, Math.min(rate, x.length - from), f, rate);
    if (share > best) [best, f0] = [share, f];
  }
  const coarse = f0;
  best = 0;
  for (let f = coarse - 0.5; f <= coarse + 0.5; f += 0.05) {
    const share = toneShare(x, 0, x.length, f, rate);
    if (share > best) [best, f0] = [share, f];
  }
  // Every second: most of the energy at the tone. Ten 100 ms windows per second, each on its own
  // (a seam's phase jump would cancel a coherent 1 s sum).
  const shares: number[] = [];
  const tenth = Math.round(rate / 10);
  for (let s = 0; s + 10 * tenth <= x.length; s += 10 * tenth) {
    let sum = 0;
    for (let k = 0; k < 10; k++) sum += toneShare(x, s + k * tenth, tenth, f0, rate);
    shares.push(sum / 10);
  }
  // Loop seams: a phase jump. Each 10 ms window is fitted with a sine at f0 (least squares on sin
  // and cos); a seam leaves a residual far above the windows around it. Merged within 300 ms (the
  // jitter buffer may smear one seam over a few windows).
  const win = Math.round(rate * 0.01);
  const w0 = (2 * Math.PI * f0) / rate;
  const residuals: number[] = [];
  for (let s = 0; s + win <= x.length; s += win) {
    let ss = 0;
    let cc = 0;
    let sc = 0;
    let xs = 0;
    let xc = 0;
    let xx = 0;
    for (let i = s; i < s + win; i++) {
      const v = x[i] as number;
      const sn = Math.sin(w0 * i);
      const cs = Math.cos(w0 * i);
      ss += sn * sn;
      cc += cs * cs;
      sc += sn * cs;
      xs += v * sn;
      xc += v * cs;
      xx += v * v;
    }
    const det = ss * cc - sc * sc;
    const a = (xs * cc - xc * sc) / det;
    const b = (xc * ss - xs * sc) / det;
    residuals.push(xx === 0 ? 1 : Math.max(0, xx - a * xs - b * xc) / xx);
  }
  const median = [...residuals].sort((p, q) => p - q)[residuals.length >> 1] as number;
  const seams: number[] = [];
  residuals.forEach((r, i) => {
    const t = (i * win) / rate;
    if (r > Math.max(0.01, 10 * median) && (seams.length === 0 || t - (seams.at(-1) as number) > 0.3)) seams.push(t);
  });
  // The first half second may still be the stream starting.
  const inner = seams.filter((t) => t > 0.5);
  const gaps = inner.slice(1).map((t, i) => t - (inner[i] as number));
  const rms = Math.sqrt(x.reduce((acc, v) => acc + v * v, 0) / x.length);
  ciNotice(
    `WHEP recording (${rate} Hz, ${(x.length / rate).toFixed(1)} s, RMS ${rms.toFixed(3)}): tone ${f0.toFixed(2)} Hz, share per second min ${Math.min(...shares).toFixed(3)}; seams at ${inner.map((t) => t.toFixed(2)).join(', ') || 'none'} s (gaps ${gaps.map((g) => g.toFixed(2)).join(', ')}); ${file}`,
  );
  expect(rms).toBeGreaterThan(0.01);
  expect(Math.abs(f0 - 440)).toBeLessThan(2);
  expect(Math.min(...shares)).toBeGreaterThan(0.8);
  // The loop of the source: tone.ogg is 201 Opus packets of 20 ms, so a seam every 4.02 s and
  // nothing else (20 s: four or five). The receiver's jitter buffer stretches and shrinks playout a
  // little, so a single gap may be off by ~0.15 s; on average they are the loop.
  expect(inner.length).toBeGreaterThanOrEqual(4);
  for (const g of gaps) {
    expect(g).toBeGreaterThan(LOOP_S - 0.25);
    expect(g).toBeLessThan(LOOP_S + 0.25);
  }
  const mean = ((inner.at(-1) as number) - (inner[0] as number)) / (inner.length - 1);
  expect(Math.abs(mean - LOOP_S)).toBeLessThan(0.05);
});
