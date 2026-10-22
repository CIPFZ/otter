// Local live CMAF-HLS source for the e2e matrix (own CMAF-HLS engine, ADR-010): the 30 s
// numbered ladder (e2e/media/frames/hls-ladder, two renditions, 2 s segments) looped forever as a
// sliding-window live playlist. Segment n of the live stream is file n % 15 with its tfdt moved on
// by whole loops, so the media timeline keeps growing (no discontinuity). The window is six
// segments, the edge advances with the wall clock since the server started; HOLD-BACK is 6 s.
// Served at /live-hls/master.m3u8 by the e2e Vite server.

import { readFileSync } from 'node:fs';
import type { Connect, Plugin } from 'vite';

const SEGMENT_S = 2;
const FILES = 15;
const WINDOW = 6;
const TIMESCALE = 15360;

/** A copy of `data` with every traf's tfdt.baseMediaDecodeTime moved by `shift` (timescale units). */
export function shiftTfdt(data: Buffer, shift: number): Buffer {
  const out = Buffer.from(data);
  const walk = (start: number, end: number, path: string[]): void => {
    let at = start;
    while (at + 8 <= end) {
      const size = out.readUInt32BE(at);
      const type = out.toString('latin1', at + 4, at + 8);
      if (size < 8) return;
      if (type === 'moof' || type === 'traf') walk(at + 8, at + size, [...path, type]);
      else if (type === 'tfdt') {
        const version = out.readUInt8(at + 8);
        if (version === 1) out.writeBigUInt64BE(out.readBigUInt64BE(at + 12) + BigInt(shift), at + 12);
        else out.writeUInt32BE(out.readUInt32BE(at + 12) + shift, at + 12);
      }
      at += size;
    }
  };
  walk(0, out.length, []);
  return out;
}

export function liveHlsPlugin(dir: string): Plugin {
  const started = Date.now();
  /** Index of the newest complete segment. */
  const edge = (): number => Math.max(WINDOW - 1, Math.floor((Date.now() - started) / 1000 / SEGMENT_S) + WINDOW - 1);
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-STREAM-INF:BANDWIDTH=636704,RESOLUTION=640x360,CODECS="avc1.42c01e"',
    'v0.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=160000,RESOLUTION=320x180,CODECS="avc1.42c00d"',
    'v1.m3u8',
    '',
  ].join('\n');
  const playlist = (r: number): string => {
    const last = edge();
    const first = last - WINDOW + 1;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${SEGMENT_S}`, '#EXT-X-SERVER-CONTROL:HOLD-BACK=6.0', `#EXT-X-MEDIA-SEQUENCE:${first}`, `#EXT-X-MAP:URI="init_${r}.mp4"`];
    // Capture time of the first segment's start: segment k is published as its end becomes the live
    // point, which is server time + 12 s (/live-hls/clock), so stream time 2k was captured at
    // started + (2k - 12) s.
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(started + (first - WINDOW) * SEGMENT_S * 1000).toISOString()}`);
    for (let n = first; n <= last; n++) lines.push(`#EXTINF:${SEGMENT_S.toFixed(6)},`, `v${r}_${n}.m4s`);
    return `${lines.join('\n')}\n`;
  };
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const path = req.url?.split('?')[0] ?? '';
    if (!path.startsWith('/live-hls/')) return next();
    const name = path.slice('/live-hls/'.length);
    const send = (type: string, body: string | Buffer): void => {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    };
    let m: RegExpExecArray | null;
    if (name === 'master.m3u8') return send('application/vnd.apple.mpegurl', master);
    // The real-time live point on the stream timeline: segment k (2k..2k+2 s) is published when
    // its end is 6 segments ahead of the server's time, so the live point is now + 12 s.
    if (name === 'clock') return send('application/json', JSON.stringify({ live: (Date.now() - started) / 1000 + WINDOW * SEGMENT_S }));
    if ((m = /^v([01])\.m3u8$/.exec(name)) !== null) return send('application/vnd.apple.mpegurl', playlist(Number(m[1])));
    if ((m = /^init_([01])\.mp4$/.exec(name)) !== null) return send('video/mp4', readFileSync(`${dir}/init_${m[1]}.mp4`));
    if ((m = /^v([01])_(\d+)\.m4s$/.exec(name)) !== null) {
      const n = Number(m[2]);
      if (n > edge()) {
        res.writeHead(404).end();
        return;
      }
      const file = readFileSync(`${dir}/v${m[1]}_${String(n % FILES).padStart(3, '0')}.m4s`);
      return send('video/iso.segment', shiftTfdt(file, Math.floor(n / FILES) * FILES * SEGMENT_S * TIMESCALE));
    }
    res.writeHead(404).end();
  };
  return {
    name: 'otter-live-hls',
    configureServer: (server) => {
      server.middlewares.use(middleware);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(middleware);
    },
  };
}
