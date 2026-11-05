// Local live MPEG-TS source for the surveillance preset on WebCodecs (ADR-013 §7): e2e/media/ts/
// live-loop.ts (the clip three times, continuous timestamps, 24 s) served at /live/stream.ts at its
// own byte rate in whole 188-byte TS packets, with 300 ms ahead, like a live origin; it ends with
// the file.
//
// `?join=mid-gop` (owner 2026-11-05): the stream starts at the first video PES at or after the
// middle of the first GOP, as a client joining there gets it: delta frames and audio come before
// the first keyframe, and the PAT / PMT with their next repetition (every ~0.1 s in the file).

import { readFileSync } from 'node:fs';
import type { Connect, Plugin } from 'vite';

const PACKET = 188;
const DURATION_S = 24.06;
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

interface PesStart {
  /** Packet index. */
  readonly i: number;
  readonly video: boolean;
  /** s. */
  readonly pts: number;
  /** random_access_indicator: the video's keyframes in this file. */
  readonly key: boolean;
  /** The ADTS sampling rate of an audio PES's first frame. */
  readonly rate?: number;
}

/** Every PES start (stream id 0xe0 video, 0xc0 audio) with its PTS. */
function pesStarts(data: Buffer): PesStart[] {
  const out: PesStart[] = [];
  for (let o = 0; o + PACKET <= data.length; o += PACKET) {
    if (((data[o + 1] as number) & 0x40) === 0) continue;
    const afc = ((data[o + 3] as number) >> 4) & 3;
    const s = o + 4 + ((afc & 2) !== 0 ? 1 + (data[o + 4] as number) : 0);
    if (data[s] !== 0 || data[s + 1] !== 0 || data[s + 2] !== 1 || ((data[s + 7] as number) & 0x80) === 0) continue;
    const id = data[s + 3] as number;
    if (id !== 0xe0 && id !== 0xc0) continue;
    const p = s + 9;
    const pts = (((data[p] as number) & 0x0e) * 2 ** 29 + (data[p + 1] as number) * 2 ** 22 + ((data[p + 2] as number) & 0xfe) * 2 ** 14 + (data[p + 3] as number) * 2 ** 7 + ((data[p + 4] as number) >> 1)) / 90_000;
    const key = (afc & 2) !== 0 && (data[o + 4] as number) > 0 && ((data[o + 5] as number) & 0x40) !== 0;
    const adts = s + 9 + (data[s + 8] as number);
    const rate = id === 0xc0 && data[adts] === 0xff ? AAC_RATES[((data[adts + 2] as number) >> 2) & 0x0f] : undefined;
    out.push({ i: o / PACKET, video: id === 0xe0, pts, key: id === 0xe0 && key, ...(rate === undefined ? {} : { rate }) });
  }
  return out;
}

/**
 * The `?join=mid-gop` start (byte offset), the keyframe the stream then reaches first and the first
 * AAC frame at or after it (s, PTS): from the file, for the e2e's expected values. Frame times are
 * the PES's PTS + n × 1024 / rate.
 */
export function tsMidGop(file: string): { offset: number; keyS: number; firstAudioS: number } {
  const starts = pesStarts(readFileSync(file));
  const keys = starts.filter((x) => x.key);
  const middle = ((keys[0]?.pts ?? 0) + (keys[1]?.pts ?? 0)) / 2;
  const from = starts.find((x) => x.video && x.pts >= middle) as PesStart;
  const key = starts.find((x) => x.key && x.i > from.i) as PesStart;
  // The first audio PES that has a frame at or after the keyframe: the one before the first that
  // starts after it (if it reaches it), else that one.
  const audio = starts.filter((x) => !x.video && x.i >= from.i);
  const next = audio.findIndex((x) => x.pts >= key.pts);
  const frame = 1024 / ((audio[0] as PesStart).rate ?? 48000);
  const before = audio[next - 1];
  const inBefore = before === undefined ? undefined : before.pts + Math.ceil((key.pts - before.pts) / frame - 1e-9) * frame;
  const firstAudioS = inBefore !== undefined && inBefore < (audio[next] as PesStart).pts - 1e-9 ? inBefore : (audio[next] as PesStart).pts;
  return { offset: from.i * PACKET, keyS: key.pts, firstAudioS };
}

export function liveTsPlugin(file: string): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split('?')[0] !== '/live/stream.ts') {
      next();
      return;
    }
    const data = readFileSync(file);
    const perSecond = data.length / DURATION_S;
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Transfer-Encoding': 'chunked' });
    const offset = new URL(req.url ?? '/', 'http://x').searchParams.get('join') === 'mid-gop' ? tsMidGop(file).offset : 0;
    const started = Date.now();
    let sent = offset;
    const pump = (): void => {
      const due = Math.min(data.length, offset + Math.floor((((Date.now() - started) / 1000 + 0.3) * perSecond) / PACKET) * PACKET);
      if (due > sent) {
        res.write(data.subarray(sent, due));
        sent = due;
      }
      if (sent >= data.length) {
        clearInterval(timer);
        res.end();
      }
    };
    const timer = setInterval(pump, 40);
    pump();
    res.on('close', () => clearInterval(timer));
  };
  return {
    name: 'otter-live-ts',
    configureServer: (server) => {
      server.middlewares.use(middleware);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(middleware);
    },
  };
}
