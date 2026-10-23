// Bandwidth-limited copy of the e2e media for benchmarks (bench-hls.spec.ts): /t/<kbps>/<sid>/<path>
// (or /t/<kbps>+<kb>k/...: the session's first <kb> kilobytes unlimited, then <kbps>: a link that
// drops after the start, hls-abandon.spec.ts)
// serves e2e/media/<path> at <kbps> kilobits per second, shared by every request of the session
// <sid> (a page's segment, playlist and init requests compete, as on a real link); 0 is unlimited
// (the same no-store responses, for a like-for-like baseline). Server side,
// so it limits Chrome and Firefox alike. Playlists' relative URLs stay under the prefix.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { Connect, Plugin } from 'vite';

const TYPES: Readonly<Record<string, string>> = { '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment', '.vtt': 'text/vtt' };
const TICK_MS = 20;

/** One token bucket per session: bytes it may send now, refilled every tick. */
interface Bucket {
  readonly bytesPerTick: number;
  readonly waiting: (() => void)[];
  budget: number;
  /** Bytes still free of the limit (the `+<kb>k` head start). */
  free: number;
  timer: ReturnType<typeof setInterval> | undefined;
  idleTicks: number;
}

export function throttlePlugin(dir: string): Plugin {
  const buckets = new Map<string, Bucket>();
  const bucket = (sid: string, kbps: number, freeKb: number): Bucket => {
    let b = buckets.get(sid);
    if (b === undefined) {
      const created: Bucket = { bytesPerTick: (kbps * 1000) / 8 / (1000 / TICK_MS), waiting: [], budget: 0, free: freeKb * 1000, timer: undefined, idleTicks: 0 };
      created.timer = setInterval(() => {
        created.budget = Math.min(created.budget + created.bytesPerTick, created.bytesPerTick * 2);
        const w = created.waiting.splice(0);
        if (w.length === 0 && ++created.idleTicks > 3000) {
          clearInterval(created.timer);
          buckets.delete(sid);
        }
        for (const wake of w) wake();
      }, TICK_MS);
      buckets.set(sid, created);
      b = created;
    }
    b.idleTicks = 0;
    return b;
  };
  /** Waits until `n` bytes may go out (in pieces of at most one tick's worth). */
  const take = async (b: Bucket, n: number): Promise<void> => {
    const head = Math.min(b.free, n);
    b.free -= head;
    let left = n - head;
    while (left > 0) {
      if (b.budget <= 0) await new Promise<void>((r) => b.waiting.push(r));
      const piece = Math.min(left, b.budget);
      b.budget -= piece;
      left -= piece;
    }
  };

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const m = /^\/t\/(\d+)(?:\+(\d+)k)?\/([\w-]+)\/(.+)$/.exec(req.url?.split('?')[0] ?? '');
    if (m === null) return next();
    const file = normalize(join(dir, decodeURIComponent(m[4] as string)));
    if (!file.startsWith(normalize(dir)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const b = Number(m[1]) === 0 ? undefined : bucket(m[3] as string, Number(m[1]), Number(m[2] ?? 0));
    const size = statSync(file).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = range === null ? 0 : Number(range[1]);
    const end = range === null || range[2] === '' ? size - 1 : Number(range[2]);
    res.writeHead(range === null ? 200 : 206, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      // no-transform: the preview server's compression would buffer the paced writes.
      'Cache-Control': 'no-store, no-transform',
      ...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${size}` }),
    });
    const stream = createReadStream(file, { start, end, highWaterMark: 16 * 1024 });
    if (Number(m[1]) === 0) {
      stream.pipe(res);
      return;
    }
    // Writes in order, each after its share of the bandwidth; the end after the last write.
    let sent: Promise<void> = Promise.resolve();
    stream.on('data', (chunk) => {
      stream.pause();
      sent = sent.then(() => take(b as Bucket, chunk.length)).then(() => {
        res.write(chunk);
        stream.resume();
      });
    });
    stream.on('end', () => void sent.then(() => res.end()));
    res.on('close', () => stream.destroy());
  };
  return {
    name: 'otter-throttle',
    configureServer: (server) => {
      server.middlewares.use(middleware);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(middleware);
    },
  };
}
