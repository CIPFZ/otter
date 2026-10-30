// Local HTTP-FLV live source for the e2e matrix (SPEC §19 "国内直播"): loops e2e/media/flv/clip.flv
// forever, paced in real time, rewriting tag timestamps so the stream is one continuous live
// timeline. Served at /live/stream.flv by the e2e Vite server, over HTTP (chunked) and over a
// WebSocket (ws://…/live/stream.flv, binary messages: WS-FLV), the latter by a minimal RFC 6455
// server here (one way, server to client) rather than a dependency.

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

function stream(file: string, out: Sink): void {
  const { header, tags } = parseFlv(readFileSync(file));
  const media = tags.filter((t) => t.type === VIDEO || t.type === AUDIO);
  const loopDuration = (media.at(-1)?.timestamp ?? 0) + 40;
  // Codec config tags (AVC sequence header, AAC AudioSpecificConfig) are sent once, at the start.
  const isConfig = (t: FlvTag): boolean => t.data.readUInt8(11 + 1) === 0;
  const config = media.filter((t) => isConfig(t) && t.timestamp === 0);
  const frames = media.filter((t) => !config.includes(t));

  out.write(header);
  for (const t of tags.filter((x) => x.type === SCRIPT)) out.write(retime(t, 0));
  for (const t of config) out.write(retime(t, 0));

  const started = Date.now();
  let loop = 0;
  let index = 0;
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

export function liveFlvPlugin(file: string): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split('?')[0] !== '/live/stream.flv') {
      next();
      return;
    }
    stream(file, httpSink(res));
  };
  const upgrade = (req: IncomingMessage, socket: Duplex): void => {
    if (req.url?.split('?')[0] === '/live/stream.flv' && /websocket/i.test(String(req.headers.upgrade))) stream(file, wsSink(req, socket));
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
