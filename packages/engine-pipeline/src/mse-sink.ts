// MSE sink (ADR-007 §2): one append queue per SourceBuffer, back-buffer eviction, and one retry
// after evicting more when the browser reports QuotaExceededError (Safari / MMS evict
// aggressively). The operation-queue idea follows hls.js' buffer-operation-queue (REUSE §3, L3
// reference, not copied).

export interface SinkInit {
  readonly type: 'audio' | 'video';
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/** A media segment appended to a SourceBuffer, for the segment ledger (ADR-010 §4). */
export interface SinkSegment {
  readonly id: string | number;
  /** Media time, seconds. */
  readonly start: number;
  readonly end: number;
  /** Rendition (quality id) it came from. */
  readonly level?: string | number;
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
  /** `segment`: recorded in the ledger once the append succeeded (segment engines). */
  append(type: 'audio' | 'video', data: Uint8Array, segment?: SinkSegment): Promise<void>;
  /**
   * Segments appended to `type` that are still buffered, in time order: entries whose middle is no
   * longer in the SourceBuffer's buffered ranges (evicted by us or by the browser) are dropped.
   */
  segments(type: 'audio' | 'video'): readonly SinkSegment[];
  /**
   * Interrupts `type` (or every buffer): pending operations reject with an AbortError, an append
   * in progress is aborted (SourceBuffer.abort()); a removal in progress finishes. The parser is
   * reset, so the next media needs its init segment again.
   */
  abort(type?: 'audio' | 'video'): void;
  /** Removes media older than `currentTime - backBufferS` on every buffer. */
  evict(currentTime: number): Promise<void>;
  /** Removes everything (seek outside the buffer / discontinuity). */
  clear(): Promise<void>;
  endOfStream(): void;
  readonly types: readonly string[];
  /**
   * Whether the browser wants more media: always with MediaSource; with ManagedMediaSource,
   * between its `startstreaming` and `endstreaming` (it stops wanting data while the page is in the
   * background or the buffer is full). Engines stop fetching while false.
   */
  readonly streaming: boolean;
  /** Resolves when `streaming` is true (at once if it is). */
  whenStreaming(): Promise<void>;
  /** Buffered ranges of one SourceBuffer (the element's are the intersection of all). */
  buffered(type: 'audio' | 'video'): [number, number][];
  destroy(): void;
}

type Op = () => void;

interface Queue {
  readonly sb: SourceBuffer;
  mimeType: string;
  readonly ops: { run: Op; done: () => void; fail: (e: unknown) => void; kind: 'append' | 'other' }[];
  busy: boolean;
  /** updateend events still to come from an aborted append: not the next operation's. */
  aborted: number;
}

const abortError = (): Error => Object.assign(new Error('SourceBuffer operation aborted'), { name: 'AbortError' });
/** Ledger entries count as buffered when their middle is (segments overlap by frames at edges). */
const inRanges = (t: number, r: readonly [number, number][]): boolean => r.some(([a, b]) => t >= a - 0.05 && t < b + 0.05);

export function createMseSink(MediaSourceCtor: typeof MediaSource, options: MseSinkOptions): MseSink {
  const ms = new MediaSourceCtor();
  const url = URL.createObjectURL(ms);
  const queues = new Map<string, Queue>();
  let destroyed = false;

  const ready = new Promise<void>((resolve) => {
    if (ms.readyState === 'open') resolve();
    else ms.addEventListener('sourceopen', () => resolve(), { once: true });
  });

  // ManagedMediaSource streaming hints (WebKit): start true, like hls.js; the browser says when.
  const managed = 'streaming' in ms;
  let streaming = managed ? (ms as MediaSource & { streaming?: boolean }).streaming !== false : true;
  let wakers: (() => void)[] = [];
  if (managed) {
    ms.addEventListener('startstreaming', () => {
      streaming = true;
      const w = wakers;
      wakers = [];
      for (const r of w) r();
    });
    ms.addEventListener('endstreaming', () => {
      streaming = false;
    });
  }

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

  const enqueue = (q: Queue, run: Op, kind: 'append' | 'other' = 'other'): Promise<void> =>
    new Promise((done, fail) => {
      q.ops.push({ run, done, fail, kind });
      next(q);
    });
  const ledger = new Map<string, SinkSegment[]>();

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
    const created: Queue = { sb, mimeType: segment.mimeType, ops: [], busy: false, aborted: 0 };
    sb.addEventListener('updateend', () => {
      if (created.aborted > 0) {
        created.aborted--;
        return;
      }
      const op = created.ops.shift();
      created.busy = false;
      op?.done();
      next(created);
    });
    sb.addEventListener('error', () => {
      if (created.aborted > 0) return;
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
    get streaming() {
      return streaming;
    },
    whenStreaming: () => (streaming || destroyed ? Promise.resolve() : new Promise<void>((r) => wakers.push(r))),
    buffered: (type) => {
      const q = queues.get(type);
      return q === undefined ? [] : ranges(q.sb);
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
    async append(type, data, segment) {
      const q = queueFor(type);
      try {
        await enqueue(q, () => q.sb.appendBuffer(data as BufferSource), 'append');
      } catch (err) {
        if ((err as { name?: string } | null)?.name !== 'QuotaExceededError') throw err;
        // Free everything well behind the playhead, then retry once.
        const r = ranges(q.sb);
        const first = r[0];
        const last = r.at(-1);
        if (first !== undefined && last !== undefined) await remove(q, first[0], Math.max(first[0], last[1] - options.backBufferS - 10));
        await enqueue(q, () => q.sb.appendBuffer(data as BufferSource), 'append');
      }
      if (segment === undefined) return;
      // The new segment replaces whatever it overlaps ('segments' mode overwrites by time).
      const list = (ledger.get(type) ?? []).filter((s) => s.id !== segment.id && (s.end <= segment.start || s.start >= segment.end));
      list.push(segment);
      list.sort((a, b) => a.start - b.start);
      ledger.set(type, list);
    },
    segments(type) {
      const q = queues.get(type);
      const r = q === undefined ? [] : ranges(q.sb);
      const kept = (ledger.get(type) ?? []).filter((s) => inRanges((s.start + s.end) / 2, r));
      ledger.set(type, kept);
      return [...kept];
    },
    abort(type) {
      for (const [t, q] of queues) {
        if (type !== undefined && t !== type) continue;
        const current = q.busy ? q.ops[0] : undefined;
        for (const op of q.ops.splice(current === undefined ? 0 : 1)) op.fail(abortError());
        // An append in progress stops now; a removal cannot be aborted (InvalidStateError) and ends.
        if (current?.kind === 'append' && q.sb.updating && ms.readyState === 'open') {
          q.aborted++;
          q.ops.shift();
          q.busy = false;
          q.sb.abort();
          current.fail(abortError());
        } else if (current === undefined && ms.readyState === 'open' && !q.sb.updating) {
          // Idle: still reset the parser (a partial media segment may be pending in it).
          q.sb.abort();
        }
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
      for (const r of wakers.splice(0)) r();
      for (const q of queues.values()) for (const op of q.ops.splice(0)) op.fail(new Error('sink destroyed'));
      URL.revokeObjectURL(url);
    },
  };
  return sink;
}
