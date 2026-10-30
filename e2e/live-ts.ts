// Local live MPEG-TS source for the surveillance preset on WebCodecs (ADR-013 §7): e2e/media/ts/
// live-loop.ts (the clip three times, continuous timestamps, 24 s) served at /live/stream.ts at its
// own byte rate in whole 188-byte TS packets, with 300 ms ahead, like a live origin; it ends with
// the file.

import { readFileSync } from 'node:fs';
import type { Connect, Plugin } from 'vite';

const PACKET = 188;
const DURATION_S = 24.06;

export function liveTsPlugin(file: string): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split('?')[0] !== '/live/stream.ts') {
      next();
      return;
    }
    const data = readFileSync(file);
    const perSecond = data.length / DURATION_S;
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Transfer-Encoding': 'chunked' });
    const started = Date.now();
    let sent = 0;
    const pump = (): void => {
      const due = Math.min(data.length, Math.floor((((Date.now() - started) / 1000 + 0.3) * perSecond) / PACKET) * PACKET);
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
