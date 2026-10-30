// The pool's Worker (ADR-008 §3), as one self-contained function: it is turned into a Blob URL
// (`(${host})()`), so it may not reference anything outside itself. It hosts decoder slots of
// any kind; a kind's worker code arrives once as a function source and is loaded with
// importScripts (no eval).
//
// Protocol (main -> worker): kind { kind, source, env } (prewarm), open { id, kind, source, env, config }, decode { id, chunk }, flush
// { id, n }, reset { id, gen }, close { id }. Worker -> main: q { id, n, busy } (queue size after
// a decode and the slot's decode time so far), f { id, gen, frame } (transferred), flushed { id, n },
// error { id, details, message }.

/* eslint-disable */
export function host(): void {
  type Out = { frame(f: unknown): void; error(details: string, message: string): void; queue(n: number): void };
  type Inst = { decode(c: unknown): void; flush(): Promise<void> | void; reset(): void; close(): void; readonly queue?: number };
  type Kind = { create(config: unknown, out: Out): Inst | Promise<Inst> };
  type Slot = { inst: Inst | undefined; pending: unknown[] | undefined; gen: number; busy: number; closed: boolean };
  const g = self as unknown as {
    __otterKinds: Record<string, (env: unknown) => Kind>;
    postMessage(m: unknown, t?: Transferable[]): void;
    onmessage: ((e: MessageEvent) => void) | null;
    importScripts(...u: string[]): void;
  };
  g.__otterKinds = {};
  const kinds = new Map<string, Promise<Kind>>();
  const slots = new Map<number, Slot>();
  const transferOf = (f: unknown): Transferable[] => {
    const i = f as { format?: string; data?: Uint8Array; close?: () => void };
    if (i.format === 'I420' && i.data instanceof Uint8Array) return [i.data.buffer as ArrayBuffer];
    return typeof i.close === 'function' ? [f as Transferable] : [];
  };
  const out = (id: number): Out => ({
    frame(f) {
      const s = slots.get(id);
      if (s === undefined || s.closed) {
        (f as { close?: () => void }).close?.();
        return;
      }
      g.postMessage({ t: 'f', id, gen: s.gen, frame: f }, transferOf(f));
    },
    error(details, message) {
      g.postMessage({ t: 'error', id, details, message });
    },
    queue(n) {
      const s = slots.get(id);
      if (s !== undefined) g.postMessage({ t: 'q', id, n, busy: s.busy });
    },
  });
  const loadKind = (kind: string, source: string, env: unknown): Promise<Kind> => {
    let k = kinds.get(kind);
    if (k === undefined) {
      k = Promise.resolve().then(() => {
        const url = URL.createObjectURL(new Blob([`self.__otterKinds[${JSON.stringify(kind)}] = (${source});`], { type: 'text/javascript' }));
        try {
          g.importScripts(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        return g.__otterKinds[kind]!(env);
      });
      kinds.set(kind, k);
    }
    return k;
  };
  const fail = (id: number, err: unknown): void => {
    g.postMessage({ t: 'error', id, details: 'workerDecoderFailed', message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  };
  const run = (s: Slot, id: number, m: { t: string; [k: string]: unknown }): void => {
    const inst = s.inst as Inst;
    try {
      if (m.t === 'decode') {
        const t0 = performance.now();
        inst.decode(m.chunk);
        s.busy += performance.now() - t0;
        g.postMessage({ t: 'q', id, n: inst.queue ?? 0, busy: s.busy, ack: 1 });
      } else if (m.t === 'flush') {
        void Promise.resolve(inst.flush())
          .catch(() => undefined)
          .then(() => g.postMessage({ t: 'flushed', id, n: m.n }));
      } else if (m.t === 'reset') {
        s.gen = m.gen as number;
        inst.reset();
      }
    } catch (err) {
      fail(id, err);
    }
  };
  g.onmessage = (e) => {
    const m = e.data as { t: string; id: number; [k: string]: unknown };
    if (m.t === 'kind') {
      // A prewarm: the kind's code loaded before its first open.
      loadKind(m.kind as string, m.source as string, m.env).catch(() => undefined);
      return;
    }
    if (m.t === 'open') {
      const s: Slot = { inst: undefined, pending: [], gen: 0, busy: 0, closed: false };
      slots.set(m.id, s);
      loadKind(m.kind as string, m.source as string, m.env)
        .then((k) => k.create(m.config, out(m.id)))
        .then((inst) => {
          if (s.closed) return inst.close();
          s.inst = inst;
          const queued = s.pending ?? [];
          s.pending = undefined;
          for (const p of queued) run(s, m.id, p as { t: string });
        })
        .catch((err: unknown) => fail(m.id, err));
      return;
    }
    const s = slots.get(m.id);
    if (s === undefined) return;
    if (m.t === 'close') {
      s.closed = true;
      slots.delete(m.id);
      try {
        s.inst?.close();
      } catch {
        // closing a failed decoder
      }
      return;
    }
    if (m.t === 'reset' && s.inst === undefined) {
      s.gen = m.gen as number;
      s.pending = (s.pending ?? []).filter((p) => (p as { t: string }).t !== 'decode');
      return;
    }
    if (s.pending !== undefined) s.pending.push(m);
    else run(s, m.id, m);
  };
}
