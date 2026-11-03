// cn-live over WebRTC (SPEC §19 国内直播, ADR-008 §8): format-whep against the local WHEP endpoint
// (e2e/whep.ts, a werift peer sending a looped VP8 clip). The MediaStream plays on the native
// backend; ICE that cannot connect goes down the fallback chain to the source's fallback (the
// local HTTP-FLV live stream).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { gapsAsStalls } from './audio-stalls';
import { analyzeTone, stepAt, stretchedGaps } from './recording';
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

// The WHEP audio as heard by the page (test round decision 3b, 2026-10-28): 20 s of the received
// track recorded through WebAudio, written as WAV (test-results/, attached to the report), and
// read back: a 440 Hz tone in every second, and the 4 s loop seam of the source (e2e/whep.ts loops
// the 4 s tone.ogg). It proves what the page received and decoded, not the system output.
test('cn-live WHEP recording: 20 s of the received audio, a 440 Hz tone with the loop seam every 4 s @solo', async ({ page, browserName }, info) => {
  test.setTimeout(90_000);
  // The real Firefox stops calling the recorder's process() after about 2.7 s (M6 F12; the worklet
  // through a muted gain with every node held changed nothing): not recordable there (RESEARCH §1).
  if (test.info().project.name === 'real-windows-firefox') {
    ciNotice('WHEP recording: the real Firefox stops the recording worklet after about 2.7 s (F12), skipped');
    test.skip(true, 'F12: recording worklet stops on the real Firefox');
  }
  // WebKit's MediaStream -> WebAudio recording path is unreliable (RESEARCH §1: pitched x1.054, or
  // phase jumps every 0.31 s): not recorded there (owner 2026-10-29); the recording acceptance is
  // the real Edge's, and WebKit's playback sound is checked by the 30 s worklet case.
  if (browserName === 'webkit') {
    ciNotice('WHEP recording: WebKit recording path unreliable (pitch x1.054 / 0.31 s phase jumps), skipped; acceptance on the real Edge');
    test.skip(true, 'WebKit recording path unreliable (RESEARCH §1)');
  }
  // F17 (owner 2026-11-03): extra seams in the recording. The receiver's own record, sampled every
  // 100 ms from the page's RTCPeerConnection (inbound-rtp audio: concealed samples, concealment
  // events, packets lost, jitter buffer delay), is lined up with the seams and the fixture's send
  // timeline below.
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    const w = window as unknown as { rx: { at: number; concealed: number; events: number; lost: number; jbDelay: number; jbEmitted: number; received: number; inserted: number; removed: number }[] };
    w.rx = [];
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) {
        super(config);
        const id = setInterval(() => {
          if (this.connectionState === 'closed') return clearInterval(id);
          void this.getStats().then((report) => {
            report.forEach((r: { type: string; kind?: string; concealedSamples?: number; concealmentEvents?: number; packetsLost?: number; jitterBufferDelay?: number; jitterBufferEmittedCount?: number; packetsReceived?: number; insertedSamplesForDeceleration?: number; removedSamplesForAcceleration?: number }) => {
              if (r.type === 'inbound-rtp' && r.kind === 'audio') w.rx.push({ at: performance.now(), concealed: r.concealedSamples ?? 0, events: r.concealmentEvents ?? 0, lost: r.packetsLost ?? 0, jbDelay: r.jitterBufferDelay ?? 0, jbEmitted: r.jitterBufferEmittedCount ?? 0, received: r.packetsReceived ?? 0, inserted: r.insertedSamplesForDeceleration ?? 0, removed: r.removedSamplesForAcceleration ?? 0 });
            });
          });
        }, 100);
      }
    } as typeof RTCPeerConnection;
  });
  await routeDocuments(page, browserName);
  await page.goto('/player.html?idle=0');
  if (!(await gathers(page))) {
    ciNotice('WHEP recording: this browser gathers no ICE candidates here; not testable');
    test.skip(true, 'no ICE candidates here');
  }
  await load(page, { src: '/whep/live', type: 'application/whep', live: true });
  await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(1);
  // The fixture's clock at the start and end of the recording (ms after its session's offer), to
  // place the RTCP record on the recording.
  const fixtureNow = async (): Promise<number | null> => ((await (await page.request.get('/whep/log/last')).json()) as { now?: number } | null)?.now ?? null;
  const recFrom = await fixtureNow();
  const rec = await page.evaluate(async (seconds) => {
    const stream = (document.querySelector('video') as HTMLVideoElement).srcObject as MediaStream;
    if (stream.getAudioTracks().length === 0) return { running: true, tracks: 0, rate: 0, b64: '', got: 0, messages: 0, calls: 0, empty: 0, stalls: [] as string[], zeroQuanta: [] as number[] };
    const ctx = new AudioContext();
    const running = await Promise.race([ctx.resume().then(() => ctx.state === 'running'), new Promise<boolean>((r) => setTimeout(() => r(false), 1000))]);
    if (!running) return { running, tracks: 1, rate: 0, b64: '', got: 0, messages: 0, calls: 0, empty: 0, stalls: [] as string[], zeroQuanta: [] as number[] };
    // Batches of 0.1 s; `calls` and `empty` (process() without an input channel) for a failure.
    const code = `registerProcessor('otter-rec', class extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(4800); this.n = 0; this.calls = 0; this.empty = 0; this.zeroQuanta = []; this.total = 0; }
      process(inputs) {
        this.calls++;
        const ch = inputs[0] && inputs[0][0];
        if (!ch) { this.empty++; return true; }
        // F17: render quanta that arrived as exact zeros (the MediaStream source had nothing to give):
        // their sample offset in the recording.
        let allZero = true;
        for (let i = 0; i < ch.length; i++) if (ch[i] !== 0) { allZero = false; break; }
        if (allZero && this.zeroQuanta.length < 200) this.zeroQuanta.push(this.total);
        this.total += ch.length;
        for (let i = 0; i < ch.length; i++) {
          this.buf[this.n++] = ch[i];
          if (this.n === this.buf.length) { this.port.postMessage({ s: this.buf, calls: this.calls, empty: this.empty, zeroQuanta: this.zeroQuanta }); this.buf = new Float32Array(4800); this.n = 0; }
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
    // The context's own time every 20 ms: stretches of >= 0.5 s without movement are the sound
    // device standing still (M6: the test instance's virtual sound card), which drops stream audio.
    const stalls: string[] = [];
    const t0 = performance.now();
    (window as unknown as { recT0: number }).recT0 = t0;
    let lastT = -1;
    let since = t0;
    const watch = setInterval(() => {
      const now = performance.now();
      if (ctx.currentTime !== lastT) {
        if (lastT >= 0 && now - since >= 500) stalls.push(`${((since - t0) / 1000).toFixed(2)} s + ${((now - since) / 1000).toFixed(2)} s`);
        lastT = ctx.currentTime;
        since = now;
      }
    }, 20);
    let calls = 0;
    let empty = 0;
    let zeroQuanta: number[] = [];
    await new Promise<void>((resolve) => {
      // At most 10 s more than the recording: what arrived by then is reported.
      setTimeout(resolve, (seconds + 10) * 1000);
      node.port.onmessage = (e: MessageEvent<{ s: Float32Array; calls: number; empty: number; zeroQuanta: number[] }>) => {
        messages++;
        ({ calls, empty, zeroQuanta } = e.data);
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
    clearInterval(watch);
    if (performance.now() - since >= 500) stalls.push(`${((since - t0) / 1000).toFixed(2)} s + open`);
    return { running, tracks: 1, rate, b64: btoa(bin), got: n, messages, calls, empty, stalls, zeroQuanta };
  }, 20);
  const recTo = await fixtureNow();
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
  // The tone, its share per second, the loop seams; seams on the recorder's own drops (exact zeros
  // from the MediaStream source: F17, the recording path) are set apart (e2e/recording.ts).
  const tone = analyzeTone(x, rate);
  const { f0, shares } = tone;
  const inner = [...tone.seams];
  // Every run says how many seams the recorder-drop window let through (owner 2026-11-03: tallied
  // like F14 in RESEARCH; three CI runs in a row green only through it are listed apart).
  ciNotice(`WHEP recording: F17 recorder-drop seams let through ${tone.recorderSeams.length}${tone.recorderSeams.length > 0 ? ` (at ${tone.recorderSeams.map((t) => t.toFixed(2)).join(', ')} s; drops ${tone.drops.map((d) => `${d.at.toFixed(2)} s, ${d.samples} zero samples`).join('; ')})` : ''}`);
  // The receiver's net time-stretching (inserted - removed samples at 48 kHz) by recording time:
  // the jitter buffer moving the seams without concealment (F17, owner 2026-11-03: it is the
  // receiver's playout, not the stream's); each gap is judged with it taken out.
  const rxStretch = await page.evaluate(() => {
    const w = window as unknown as { rx?: { at: number; inserted: number; removed: number }[]; recT0?: number };
    const t0 = w.recT0 ?? 0;
    const base = w.rx?.find((x) => x.at >= t0);
    return (w.rx ?? []).filter((x) => x.at >= t0).map((x) => ({ at: (x.at - t0) / 1000, value: ((x.inserted - (base?.inserted ?? 0)) - (x.removed - (base?.removed ?? 0))) / 48_000 }));
  });
  const { raw: gaps, corrected: stretchCorrected } = stretchedGaps(inner, stepAt(rxStretch));
  // F17: each seam that is not on the loop (more than 0.25 s off a multiple of LOOP_S from the
  // first) with, within 0.5 s of it, the receiver's concealment / loss / jitter-buffer changes and
  // the fixture's audio send gaps over 60 ms (it sends every 20 ms).
  {
    const rx = await page.evaluate(() => {
      const w = window as unknown as { rx: { at: number; concealed: number; events: number; lost: number; jbDelay: number; jbEmitted: number; received: number; inserted: number; removed: number }[]; recT0: number };
      return { rx: w.rx, t0: w.recT0 };
    });
    const sentLog = (await (await page.request.get('/whep/log/last')).json()) as { audioSent?: number[] } | null;
    const sent = sentLog?.audioSent ?? [];
    const first = inner[0] ?? 0;
    const odd = [...inner.filter((t) => { const k = Math.round((t - first) / LOOP_S); return Math.abs(t - first - k * LOOP_S) > 0.25; }), ...tone.recorderSeams];
    // Recording seconds to the fixture's clock: recFrom (fixture ms) is the recording's start.
    const fixtureAt = (t: number): number => (recFrom ?? 0) + t * 1000;
    const pageAt = (t: number): number => rx.t0 + t * 1000;
    const sendGaps = sent.slice(1).flatMap((t, i) => (t - (sent[i] as number) > 60 ? [{ from: sent[i] as number, to: t }] : []));
    const lines = (odd.length > 0 ? odd : inner.slice(0, 1)).map((t) => {
      const near = rx.rx.filter((x) => Math.abs(x.at - pageAt(t)) <= 500);
      const a = near[0];
      const b = near.at(-1);
      const d = a === undefined || b === undefined ? 'no receiver stats' : `concealed +${b.concealed - a.concealed} samples, concealment events +${b.events - a.events}, lost +${b.lost - a.lost}, received +${b.received - a.received}, jitter buffer ${b.jbEmitted > 0 ? Math.round((b.jbDelay / b.jbEmitted) * 1000) : '?'} ms`;
      const g = sendGaps.filter((x) => x.to >= fixtureAt(t) - 500 && x.from <= fixtureAt(t) + 500).map((x) => `${x.to - x.from} ms at ${Math.round((x.from - (recFrom ?? 0)) / 10) / 100} s`);
      // Silent render quanta (exact zeros from the MediaStream source) within 50 ms of the seam.
      const z = rec.zeroQuanta.filter((q) => Math.abs(q / rate - t) <= 0.05).length;
      return `${odd.length > 0 ? 'odd seam' : 'seam'} ${t.toFixed(2)} s: ${d}; recorder got ${z} all-zero render quanta there; fixture audio send gaps > 60 ms ${g.join(', ') || 'none'}`;
    });
    // The receiver's time-stretching over the recording (its jitter buffer slowing playout down /
    // speeding it up): moves the seams without any concealment.
    const inRec = rx.rx.filter((x) => x.at >= rx.t0 && x.at <= rx.t0 + 20_000);
    const r0 = inRec[0];
    const r1 = inRec.at(-1);
    const stretch = r0 === undefined || r1 === undefined ? '' : `, samples inserted to slow down ${r1.inserted - r0.inserted} (${((r1.inserted - r0.inserted) / 48).toFixed(0)} ms at 48 kHz), removed to speed up ${r1.removed - r0.removed}, jitter buffer ${r0.jbEmitted > 0 ? Math.round((r0.jbDelay / r0.jbEmitted) * 1000) : '?'} -> ${r1.jbEmitted > 0 ? Math.round(((r1.jbDelay - r0.jbDelay) / Math.max(1, r1.jbEmitted - r0.jbEmitted)) * 1000) : '?'} ms`;
    const whole = `${rx.rx.length > 1 ? `whole recording: concealment events ${(rx.rx.at(-1)?.events ?? 0) - (rx.rx[0]?.events ?? 0)}, lost ${(rx.rx.at(-1)?.lost ?? 0) - (rx.rx[0]?.lost ?? 0)}${stretch}` : 'no receiver stats'}; all-zero render quanta ${rec.zeroQuanta.length} (at ${rec.zeroQuanta.slice(0, 12).map((q) => (q / rate).toFixed(2)).join(', ')} s); fixture send gaps > 60 ms ${sendGaps.length}`;
    ciNotice(`WHEP recording, F17: ${lines.join(' | ')}; ${whole}`);
  }
  const rms = Math.sqrt(x.reduce((acc, v) => acc + v * v, 0) / x.length);
  ciNotice(
    `WHEP recording (${rate} Hz, ${(x.length / rate).toFixed(1)} s, RMS ${rms.toFixed(3)}): tone ${f0.toFixed(2)} Hz, share per second min ${Math.min(...shares).toFixed(3)}; seams at ${inner.map((t) => t.toFixed(2)).join(', ') || 'none'} s (gaps ${gaps.map((g) => g.toFixed(2)).join(', ')}; with the receiver's stretch taken out ${stretchCorrected.map((g) => g.toFixed(2)).join(', ')}); ${file}`,
  );
  // The fixture's side of the session (owner 2026-11-03): connection state changes and RTCP arrival
  // intervals, with the gaps over 1 s that fall in the recording. Not a skip rule (yet): locally
  // every run had such gaps in its recording (4 of 4, seams all 4.02 s), so they do not tell a bad
  // recording from a good one (M6.md, awaiting the owner).
  // The latest session the fixture answered (this case runs alone, @solo).
  const log = (await (await page.request.get('/whep/log/last')).json()) as { states: { at: number; what: string }[]; rtcp: number[] } | null;
  const rtcpStalls = log === null || recFrom === null || recTo === null ? [] : gapsAsStalls(log.rtcp, 1000, recFrom, recTo);
  if (log !== null) {
    const iv = log.rtcp.slice(1).map((t, i) => t - (log.rtcp[i] as number));
    const sorted = [...iv].sort((p, q) => p - q);
    const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    ciNotice(`WHEP recording, fixture session: states ${log.states.map((s) => `${s.what} @${s.at}`).join(', ')}; recording ${recFrom}..${recTo} ms; RTCP ${log.rtcp.length} packets, interval p50 ${p(0.5)} / p95 ${p(0.95)} / max ${p(1)} ms${iv.some((x) => x > 1000) ? `; gaps > 1 s at ${log.rtcp.filter((_, i) => (iv[i - 1] ?? 0) > 1000).join(', ')} ms` : ''}; in the recording ${rtcpStalls.map((x) => `${x.from}..${x.to ?? 'open'}`).join(', ') || 'none'}`);
  }
  if (rec.stalls.length > 0) {
    // The device stood still during the recording: stream audio is dropped there, the seams move.
    ciNotice(`WHEP recording: 环境停顿 (environment stall) at ${rec.stalls.join(', ')}; checks skipped`);
    test.skip(true, `environment stall during the recording: ${rec.stalls.join(', ')}`);
  }
  expect(rms).toBeGreaterThan(0.01);
  expect(Math.abs(f0 - 440)).toBeLessThan(2);
  expect(Math.min(...shares)).toBeGreaterThan(0.8);
  // The loop of the source: tone.ogg is 201 Opus packets of 20 ms, so a seam every 4.02 s and
  // nothing else (20 s: four or five). The receiver's jitter buffer stretches and shrinks playout a
  // little, so a single gap may be off by ~0.15 s; on average they are the loop.
  expect(inner.length).toBeGreaterThanOrEqual(4);
  // Judged with the receiver's time-stretching taken out (F17); the raw gaps are in the notice.
  for (const g of stretchCorrected) {
    expect(g, `gap ${g.toFixed(2)} s with the receiver's stretch taken out (raw ${gaps.map((x) => x.toFixed(2)).join(', ')})`).toBeGreaterThan(LOOP_S - 0.25);
    expect(g, `gap ${g.toFixed(2)} s with the receiver's stretch taken out (raw ${gaps.map((x) => x.toFixed(2)).join(', ')})`).toBeLessThan(LOOP_S + 0.25);
  }
  const mean = stretchCorrected.reduce((a, b) => a + b, 0) / Math.max(1, stretchCorrected.length);
  expect(Math.abs(mean - LOOP_S), `mean gap ${mean.toFixed(3)} s with the stretch taken out`).toBeLessThan(0.05);
});
