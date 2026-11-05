// Local HTTP-FLV live source for the e2e matrix (SPEC §19 "国内直播"): loops e2e/media/flv/clip.flv
// forever, paced in real time, rewriting tag timestamps so the stream is one continuous live
// timeline. Served at /live/stream.flv by the e2e Vite server, over HTTP (chunked) and over a
// WebSocket (ws://…/live/stream.flv, binary messages: WS-FLV), the latter by a minimal RFC 6455
// server here (one way, server to client) rather than a dependency.
//
// `?join=mid-gop` (owner 2026-11-05): the stream starts in the middle of the clip's first GOP, as a
// server without a GOP cache sends it to a client that joins there: delta frames and audio come
// before the first keyframe (the configuration tags still come first).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Connect, Plugin } from 'vite';

interface FlvTag {
  readonly type: number;
  readonly timestamp: number;
  readonly data: Buffer;
}

/** Splits an FLV file into header (incl. PreviousTagSize0) and tags. */
export function parseFlv(file: Buffer): { header: Buffer; tags: FlvTag[] } {
  if (file.toString('latin1', 0, 3) !== 'FLV') throw new Error('not an FLV file');
  const headerSize = file.readUInt32BE(5);
  const header = file.subarray(0, headerSize + 4);
  const tags: FlvTag[] = [];
  let pos = headerSize + 4;
  while (pos + 11 <= file.length) {
    const type = file.readUInt8(pos);
    const size = file.readUIntBE(pos + 1, 3);
    const timestamp = file.readUIntBE(pos + 4, 3) | (file.readUInt8(pos + 7) << 24);
    const end = pos + 11 + size + 4;
    if (end > file.length) break;
    tags.push({ type, timestamp, data: file.subarray(pos, end) });
    pos = end;
  }
  return { header, tags };
}

/** Copy of a tag (incl. trailing PreviousTagSize) with a new timestamp. */
export function retime(tag: FlvTag, timestamp: number): Buffer {
  const out = Buffer.from(tag.data);
  out.writeUIntBE(timestamp & 0xffffff, 4, 3);
  out.writeUInt8((timestamp >>> 24) & 0xff, 7);
  return out;
}

const SCRIPT = 18;
const VIDEO = 9;
const AUDIO = 8;

/** Where the stream's bytes go: an HTTP response or a WebSocket. */
interface Sink {
  write(b: Buffer): boolean;
  onClose(h: () => void): void;
}

function httpSink(res: ServerResponse): Sink {
  res.writeHead(200, {
    'Content-Type': 'video/x-flv',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Transfer-Encoding': 'chunked',
  });
  return { write: (b) => res.write(b), onClose: (h) => res.on('close', h) };
}

/** RFC 6455 server side: the handshake, then each write as one unmasked binary frame. */
function wsSink(req: IncomingMessage, socket: Duplex): Sink {
  const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  // Frames from the client (a close, pings) are not answered: the stream runs until the socket closes.
  socket.on('data', () => undefined);
  socket.on('error', () => undefined);
  return {
    write(b) {
      const head = b.length < 126 ? Buffer.from([0x82, b.length]) : b.length < 65536 ? Buffer.from([0x82, 126, b.length >> 8, b.length & 0xff]) : Buffer.concat([Buffer.from([0x82, 127, 0, 0, 0, 0]), Buffer.from([(b.length >>> 24) & 0xff, (b.length >>> 16) & 0xff, (b.length >>> 8) & 0xff, b.length & 0xff])]);
      socket.write(head);
      return socket.write(b);
    },
    onClose: (h) => socket.on('close', h),
  };
}

/** Codec config tags (AVC sequence header, AAC AudioSpecificConfig), sent once at the start; the rest. */
function split(tags: readonly FlvTag[]): { config: FlvTag[]; frames: FlvTag[] } {
  const media = tags.filter((t) => t.type === VIDEO || t.type === AUDIO);
  const isConfig = (t: FlvTag): boolean => t.data.readUInt8(11 + 1) === 0;
  const config = media.filter((t) => isConfig(t) && t.timestamp === 0);
  return { config, frames: media.filter((t) => !config.includes(t)) };
}

const isKey = (t: FlvTag): boolean => t.type === VIDEO && t.data.readUInt8(11) >> 4 === 1;

/**
 * The `?join=mid-gop` start: the first frame tag at or after the middle of the first GOP, the
 * keyframe the stream then reaches first (FLV ms), and the first audio tag at or after it: from the
 * file, for the e2e's expected values.
 */
export function flvMidGop(file: string): { index: number; startMs: number; keyMs: number; firstAudioMs: number } {
  const { frames } = split(parseFlv(readFileSync(file)).tags);
  const keys = frames.filter(isKey);
  const middle = ((keys[0]?.timestamp ?? 0) + (keys[1]?.timestamp ?? 0)) / 2;
  const index = frames.findIndex((t) => t.timestamp >= middle);
  const key = frames.slice(index).find(isKey) as FlvTag;
  const audio = frames.slice(index).find((t) => t.type === AUDIO && t.timestamp >= key.timestamp) as FlvTag;
  return { index, startMs: (frames[index] as FlvTag).timestamp, keyMs: key.timestamp, firstAudioMs: audio.timestamp };
}

function stream(file: string, out: Sink, join: string | null): void {
  const { header, tags } = parseFlv(readFileSync(file));
  const { config, frames } = split(tags);
  const loopDuration = (frames.at(-1)?.timestamp ?? 0) + 40;
  const from = join === 'mid-gop' ? flvMidGop(file) : { index: 0, startMs: 0 };

  out.write(header);
  for (const t of tags.filter((x) => x.type === SCRIPT)) out.write(retime(t, 0));
  for (const t of config) out.write(retime(t, 0));

  // Paced from the first tag sent (mid-GOP: its own timestamp, not 0).
  const started = Date.now() - from.startMs;
  let loop = 0;
  let index = from.index;
  const pump = (): void => {
    const elapsed = Date.now() - started;
    // Send everything up to "now" plus a 300 ms lead, like a live origin with a small buffer.
    while (true) {
      const tag = frames[index];
      if (tag === undefined) {
        loop++;
        index = 0;
        continue;
      }
      const ts = loop * loopDuration + tag.timestamp;
      if (ts > elapsed + 300) break;
      if (!out.write(retime(tag, ts))) break;
      index++;
    }
  };
  const timer = setInterval(pump, 40);
  pump();
  out.onClose(() => clearInterval(timer));
}

const joinOf = (req: IncomingMessage): string | null => new URL(req.url ?? '/', 'http://x').searchParams.get('join');

export function liveFlvPlugin(file: string): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split('?')[0] !== '/live/stream.flv') {
      next();
      return;
    }
    stream(file, httpSink(res), joinOf(req));
  };
  const upgrade = (req: IncomingMessage, socket: Duplex): void => {
    if (req.url?.split('?')[0] === '/live/stream.flv' && /websocket/i.test(String(req.headers.upgrade))) stream(file, wsSink(req, socket), joinOf(req));
  };
  return {
    name: 'otter-live-flv',
    configureServer: (server) => {
      server.middlewares.use(middleware);
      server.httpServer?.on('upgrade', upgrade);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(middleware);
      server.httpServer.on('upgrade', upgrade);
    },
  };
}
