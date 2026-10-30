// Shared Worker decode pool (SPEC §6.3, ADR-008 §3). Decoder plugins hand the pool their worker
// code (WorkerCodec); the pool runs it in at most `size` Workers (default min(cores, 4)), with
// at most `maxDecoders` decoders at once (default 16; more wait in a FIFO queue and are told
// why). The main thread only posts encoded chunks and receives frames, transferred: VideoFrame
// as is, I420 pictures as their ArrayBuffer.

import { createError, type OtterError } from '@otter-player/core';
import type { DecodedFrame, DecoderConfig, DecoderInstance, EncodedChunk, I420Frame } from '@otter-player/media';
import { host } from './host.js';

/**
 * A decoder implementation that runs in a pool Worker. `source` is a function expression,
 * `(env) => ({ create(config, out) })`, self-contained (no imports or closures); `create`
 * returns `{ decode(chunk), flush(), reset(), close(), queue? }` and reports through
 * `out.frame(frame)`, `out.error(details, message)`, `out.queue(size)`.
 */
export interface WorkerCodec {
  /** One per implementation and version, e.g. `webcodecs`, `jessibuca-ffmpeg`. */
  readonly kind: string;
  readonly source: string;
  /** Structured-cloneable data for the kind (asset URLs, feature flags), sent once per Worker. */
  readonly env?: unknown;
}

export interface PoolOpenOptions {
  /** Name in pool statistics (e.g. the stream it decodes). */
  readonly label?: string;
  /** Called when the decoder waits for a free slot (more than maxDecoders open). */
  readonly queued?: (reason: string) => void;
  /** Called when a waiting decoder got its slot. */
  readonly started?: () => void;
}

export interface PoolSlotStats {
  readonly id: number;
  readonly label: string;
  readonly worker: number;
  readonly kind: string;
  /** Milliseconds the Worker spent inside decode() for this slot. */
  readonly busyMs: number;
  readonly frames: number;
  readonly openedAt: number;
}

export interface PoolStats {
  readonly workers: number;
  readonly active: number;
  readonly queued: number;
  readonly slots: readonly PoolSlotStats[];
}

export interface DecodePool {
  readonly size: number;
  readonly maxDecoders: number;
  /** A DecoderInstance backed by a pool Worker; queued (not failed) beyond maxDecoders. */
  open(codec: WorkerCodec, config: DecoderConfig, options?: PoolOpenOptions): DecoderInstance;
  /** Starts up to `count` Workers (at most `size`) with the kind's code loaded, ahead of the first open. */
  warm(codec: WorkerCodec, count: number): void;
  stats(): PoolStats;
  destroy(): void;
}

export interface DecodePoolOptions {
  readonly size?: number;
  readonly maxDecoders?: number;
}

const DEFAULT_MAX_DECODERS = 16;

interface WorkerEntry {
  readonly index: number;
  readonly worker: Worker;
  /** Kinds already sent to this Worker. */
  readonly kinds: Set<string>;
  slots: number;
}

interface Slot {
  readonly id: number;
  readonly codec: WorkerCodec;
  readonly config: DecoderConfig;
  readonly options: PoolOpenOptions;
  worker: WorkerEntry | undefined;
  gen: number;
  /** Chunks / commands posted before the slot started (queued). */
  backlog: { t: string; [k: string]: unknown }[];
  /** Decodes posted and not yet acknowledged by the Worker. */
  inFlight: number;
  /** Queue size the Worker reported. */
  queue: number;
  busy: number;
  frames: number;
  flushes: Map<number, () => void>;
  nextFlush: number;
  state: 'queued' | 'configured' | 'closed';
  failed: boolean;
  openedAt: number;
}

let hostUrl: string | undefined;
/** The pool Worker's script, as a Blob URL made once per page. */
const workerUrl = (): string => (hostUrl ??= URL.createObjectURL(new Blob([`(${host.toString()})();`], { type: 'text/javascript' })));

const configOnly = (c: DecoderConfig): Record<string, unknown> => {
  const { output: _o, error: _e, queued: _q, started: _s, ...rest } = c;
  return rest;
};

export function createDecodePool(options: DecodePoolOptions = {}): DecodePool {
  const cores = typeof navigator === 'object' && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4;
  const size = Math.max(1, options.size ?? Math.min(cores, 4));
  const maxDecoders = Math.max(1, options.maxDecoders ?? DEFAULT_MAX_DECODERS);
  const workers: WorkerEntry[] = [];
  const slots = new Map<number, Slot>();
  const waiting: Slot[] = [];
  let ids = 0;
  let destroyed = false;
  const active = (): number => [...slots.values()].filter((s) => s.state === 'configured').length;

  const fail = (s: Slot, details: string, message: string): void => {
    if (s.failed || s.state === 'closed') return;
    s.failed = true;
    const err: OtterError = createError({ type: 'media', details, fatal: true, recoverable: true, message });
    s.config.error(err);
  };

  const onMessage = (w: WorkerEntry, e: MessageEvent): void => {
    const m = e.data as { t: string; id: number; gen?: number; frame?: unknown; n?: number; busy?: number; ack?: number; details?: string; message?: string };
    const s = slots.get(m.id);
    if (s === undefined || s.state === 'closed') {
      if (m.t === 'f') (m.frame as { close?: () => void } | undefined)?.close?.();
      return;
    }
    if (m.t === 'f') {
      if (m.gen !== s.gen) {
        (m.frame as { close?: () => void }).close?.();
        return;
      }
      s.frames++;
      const f = m.frame as I420Frame | VideoFrame;
      s.config.output(f as DecodedFrame);
    } else if (m.t === 'q') {
      if (m.ack === 1) s.inFlight = Math.max(0, s.inFlight - 1);
      s.queue = m.n ?? 0;
      s.busy = m.busy ?? s.busy;
    } else if (m.t === 'flushed') {
      s.flushes.get(m.n as number)?.();
      s.flushes.delete(m.n as number);
    } else if (m.t === 'error') {
      fail(s, m.details ?? 'decodeError', m.message ?? 'worker decoder error');
    }
    void w;
  };

  const spawn = (): WorkerEntry => {
    const entry: WorkerEntry = { index: workers.length, worker: new Worker(workerUrl()), kinds: new Set(), slots: 0 };
    entry.worker.onmessage = (e) => onMessage(entry, e);
    entry.worker.onerror = (e) => {
      e.preventDefault();
      for (const s of slots.values()) if (s.worker === entry) fail(s, 'workerCrashed', e.message || 'decode worker failed');
    };
    workers.push(entry);
    return entry;
  };

  /** Least loaded Worker; a new one while below `size`. */
  const pick = (): WorkerEntry => {
    const idle = workers.reduce<WorkerEntry | undefined>((best, w) => (best === undefined || w.slots < best.slots ? w : best), undefined);
    if (workers.length < size && (idle === undefined || idle.slots > 0)) return spawn();
    return idle as WorkerEntry;
  };

  const post = (s: Slot, m: { t: string; [k: string]: unknown }, transfer: Transferable[] = []): void => {
    if (s.state === 'queued' || s.worker === undefined) {
      s.backlog.push(m);
      return;
    }
    s.worker.worker.postMessage({ ...m, id: s.id }, transfer);
  };

  const start = (s: Slot): void => {
    const w = pick();
    w.slots++;
    s.worker = w;
    s.state = 'configured';
    const first = !w.kinds.has(s.codec.kind);
    w.kinds.add(s.codec.kind);
    w.worker.postMessage({
      t: 'open',
      id: s.id,
      kind: s.codec.kind,
      source: first ? s.codec.source : '',
      env: s.codec.env,
      config: configOnly(s.config),
    });
    const backlog = s.backlog;
    s.backlog = [];
    s.inFlight += backlog.filter((m) => m.t === 'decode').length;
    for (const m of backlog) {
      const chunk = (m['chunk'] as EncodedChunk | undefined)?.data;
      w.worker.postMessage({ ...m, id: s.id }, chunk === undefined ? [] : [chunk]);
    }
  };

  const release = (s: Slot): void => {
    if (s.worker !== undefined) s.worker.slots--;
    const next = waiting.shift();
    if (next !== undefined && !destroyed) {
      start(next);
      next.options.started?.();
      next.config.started?.();
    }
  };

  return {
    size,
    maxDecoders,
    open(codec, config, opts = {}) {
      if (destroyed) throw createError({ type: 'other', details: 'poolDestroyed', fatal: true, recoverable: false, message: 'decode pool destroyed' });
      const s: Slot = {
        id: ++ids,
        codec,
        config,
        options: opts,
        worker: undefined,
        gen: 0,
        backlog: [],
        inFlight: 0,
        queue: 0,
        busy: 0,
        frames: 0,
        flushes: new Map(),
        nextFlush: 0,
        state: 'queued',
        failed: false,
        openedAt: performance.now(),
      };
      slots.set(s.id, s);
      if (active() < maxDecoders) start(s);
      else {
        waiting.push(s);
        const reason = `${maxDecoders} decoders busy (pool limit); waiting, ${waiting.length} in line`;
        opts.queued?.(reason);
        config.queued?.(reason);
      }
      return {
        get state() {
          return s.state === 'closed' ? 'closed' : 'configured';
        },
        get decodeQueueSize() {
          return s.backlog.filter((m) => m.t === 'decode').length + s.inFlight + s.queue;
        },
        decode(chunk) {
          if (s.state === 'closed' || s.failed) return;
          s.inFlight += s.state === 'queued' ? 0 : 1;
          post(s, { t: 'decode', chunk }, [chunk.data]);
        },
        flush() {
          if (s.state === 'closed') return Promise.resolve();
          const n = ++s.nextFlush;
          return new Promise<void>((resolve) => {
            s.flushes.set(n, resolve);
            post(s, { t: 'flush', n });
          });
        },
        reset() {
          if (s.state === 'closed') return;
          s.gen++;
          s.backlog = s.backlog.filter((m) => m.t !== 'decode');
          s.inFlight = 0;
          s.queue = 0;
          for (const r of s.flushes.values()) r();
          s.flushes.clear();
          post(s, { t: 'reset', gen: s.gen });
        },
        close() {
          if (s.state === 'closed') return;
          const wasActive = s.state === 'configured';
          if (s.worker !== undefined) s.worker.worker.postMessage({ t: 'close', id: s.id });
          s.state = 'closed';
          for (const r of s.flushes.values()) r();
          slots.delete(s.id);
          const i = waiting.indexOf(s);
          if (i >= 0) waiting.splice(i, 1);
          if (wasActive) release(s);
        },
      };
    },
    warm(codec, count) {
      if (destroyed) return;
      while (workers.length < Math.min(size, count)) spawn();
      for (const w of workers.slice(0, Math.min(size, count))) {
        if (w.kinds.has(codec.kind)) continue;
        w.kinds.add(codec.kind);
        w.worker.postMessage({ t: 'kind', kind: codec.kind, source: codec.source, env: codec.env });
      }
    },
    stats() {
      return {
        workers: workers.length,
        active: active(),
        queued: waiting.length,
        slots: [...slots.values()].map((s) => ({
          id: s.id,
          label: s.options.label ?? `decoder ${s.id}`,
          worker: s.worker?.index ?? -1,
          kind: s.codec.kind,
          busyMs: s.busy,
          frames: s.frames,
          openedAt: s.openedAt,
        })),
      };
    },
    destroy() {
      destroyed = true;
      for (const w of workers) w.worker.terminate();
      workers.length = 0;
      slots.clear();
      waiting.length = 0;
    },
  };
}

let shared: DecodePool | undefined;

/** The page-wide pool every pooled decoder uses unless given another (ADR-008 §3). */
export function sharedDecodePool(): DecodePool {
  shared ??= createDecodePool();
  return shared;
}
