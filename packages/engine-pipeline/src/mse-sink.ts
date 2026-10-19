// MSE sink (ADR-007 §2): one append queue per SourceBuffer, back-buffer eviction, and one retry
// after evicting more when the browser reports QuotaExceededError (Safari / MMS evict
// aggressively). The operation-queue idea follows hls.js' buffer-operation-queue (REUSE §3, L3
// reference, not copied).

export interface SinkInit {
  readonly type: 'audio' | 'video';
  readonly mimeType: string;
  readonly data: Uint8Array;
}

export interface MseSinkOptions {
  /** Seconds kept behind the playhead before removal. */
  readonly backBufferS: number;
}

export interface MseSink {
  readonly mediaSource: MediaSource;
  /** Resolves once the MediaSource is open (attach it with `media.src = url` first). */
  readonly ready: Promise<void>;
  readonly url: string;
  /**
   * Creates every missing SourceBuffer of the batch first, then appends the init segments: Chrome
   * refuses addSourceBuffer once another SourceBuffer received data. Later inits of a known type
   * re-initialise it (changeType when the codec changed).
   */
  init(segments: readonly SinkInit[]): Promise<void>;
  append(type: 'audio' | 'video', data: Uint8Array): Promise<void>;
  /** Removes media older than `currentTime - backBufferS` on every buffer. */
  evict(currentTime: number): Promise<void>;
  /** Removes everything (seek outside the buffer / discontinuity). */
  clear(): Promise<void>;
  endOfStream(): void;
  readonly types: readonly string[];
  destroy(): void;
}

type Op = () => void;

interface Queue {
  readonly sb: SourceBuffer;
  mimeType: string;
  readonly ops: { run: Op; done: () => void; fail: (e: unknown) => void }[];
  busy: boolean;
}

export function createMseSink(MediaSourceCtor: typeof MediaSource, options: MseSinkOptions): MseSink {
  const ms = new MediaSourceCtor();
  const url = URL.createObjectURL(ms);
  const queues = new Map<string, Queue>();
  let destroyed = false;

  const ready = new Promise<void>((resolve) => {
    if (ms.readyState === 'open') resolve();
    else ms.addEventListener('sourceopen', () => resolve(), { once: true });
  });

  const next = (q: Queue): void => {
    if (q.busy || destroyed) return;
    const op = q.ops[0];
    if (op === undefined) return;
    q.busy = true;
    try {
      op.run();
    } catch (err) {
      q.busy = false;
      q.ops.shift();
      op.fail(err);
      next(q);
    }
  };

  const enqueue = (q: Queue, run: Op): Promise<void> =>
    new Promise((done, fail) => {
      q.ops.push({ run, done, fail });
      next(q);
    });

  const queueFor = (type: string): Queue => {
    const q = queues.get(type);
    if (q === undefined) throw new Error(`no SourceBuffer for ${type}`);
    return q;
  };

  const ranges = (sb: SourceBuffer): [number, number][] => {
    const out: [number, number][] = [];
    try {
      for (let i = 0; i < sb.buffered.length; i++) out.push([sb.buffered.start(i), sb.buffered.end(i)]);
    } catch {
      // Removed from its MediaSource.
    }
    return out;
  };

  const addBuffer = (segment: SinkInit): void => {
    const sb = ms.addSourceBuffer(segment.mimeType);
    // Fragments carry their own timestamps; 'segments' keeps them (no 'sequence' re-stamping).
    sb.mode = 'segments';
    const created: Queue = { sb, mimeType: segment.mimeType, ops: [], busy: false };
    sb.addEventListener('updateend', () => {
      const op = created.ops.shift();
      created.busy = false;
      op?.done();
      next(created);
    });
    sb.addEventListener('error', () => {
      const op = created.ops.shift();
      created.busy = false;
      op?.fail(new Error('SourceBuffer error'));
      next(created);
    });
    queues.set(segment.type, created);
  };

  const remove = (q: Queue, start: number, end: number): Promise<void> =>
    end > start ? enqueue(q, () => q.sb.remove(start, end)) : Promise.resolve();

  const sink: MseSink = {
    mediaSource: ms,
    ready,
    url,
    get types() {
      return [...queues.keys()];
    },
    async init(segments) {
      await ready;
      for (const segment of segments) if (!queues.has(segment.type)) addBuffer(segment);
      for (const segment of segments) {
        const q = queueFor(segment.type);
        if (q.mimeType !== segment.mimeType) {
          const target = q;
          const mime = segment.mimeType;
          await enqueue(target, () => {
            // changeType has no updateend; run it synchronously and complete the op by hand.
            target.sb.changeType(mime);
            target.busy = false;
            target.ops.shift()?.done();
            next(target);
          });
          target.mimeType = mime;
        }
        await sink.append(segment.type, segment.data);
      }
    },
    async append(type, data) {
      const q = queueFor(type);
      try {
        await enqueue(q, () => q.sb.appendBuffer(data as BufferSource));
      } catch (err) {
        if ((err as { name?: string } | null)?.name !== 'QuotaExceededError') throw err;
        // Free everything well behind the playhead, then retry once.
        const r = ranges(q.sb);
        const first = r[0];
        const last = r.at(-1);
        if (first !== undefined && last !== undefined) await remove(q, first[0], Math.max(first[0], last[1] - options.backBufferS - 10));
        await enqueue(q, () => q.sb.appendBuffer(data as BufferSource));
      }
    },
    async evict(currentTime) {
      const until = currentTime - options.backBufferS;
      await Promise.all(
        [...queues.values()].map((q) => {
          const first = ranges(q.sb)[0];
          return first === undefined || first[0] >= until ? Promise.resolve() : remove(q, first[0], until);
        }),
      );
    },
    async clear() {
      await Promise.all(
        [...queues.values()].map((q) => {
          const r = ranges(q.sb);
          const first = r[0];
          const last = r.at(-1);
          return first === undefined || last === undefined ? Promise.resolve() : remove(q, first[0], last[1]);
        }),
      );
    },
    endOfStream() {
      if (ms.readyState !== 'open') return;
      if ([...queues.values()].some((q) => q.busy || q.ops.length > 0)) {
        // Wait for pending appends.
        Promise.all([...queues.values()].map((q) => enqueue(q, () => {
          q.busy = false;
          q.ops.shift()?.done();
          next(q);
        }))).then(() => sink.endOfStream(), () => undefined);
        return;
      }
      try {
        ms.endOfStream();
      } catch {
        // Already ended or detached.
      }
    },
    destroy() {
      destroyed = true;
      for (const q of queues.values()) for (const op of q.ops.splice(0)) op.fail(new Error('sink destroyed'));
      URL.revokeObjectURL(url);
    },
  };
  return sink;
}
