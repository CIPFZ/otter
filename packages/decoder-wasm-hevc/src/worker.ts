// Worker side of the WASM decoder for @otter-player/decoder-pool: a self-contained function
// expression (the pool loads its source into a Worker), so no imports and no outer references.
// One Jessibuca jv4-decoder module per Worker (fixed 128 MB heap), one embind VideoDecoder per
// stream. Two quirks of the copied glue are worked around here instead of patching the binary
// (UPSTREAM.json localChanges): parameter sets go in-band as Annex B (its extradata pointer
// outlives the string it points into), and frames are numbered instead of passing the timestamp
// (it is an unsigned int: microseconds would wrap after 71 minutes).

/* eslint-disable */
export const wasmWorker: (env: { glueUrl: string; wasmUrl: string }) => unknown = (env) => {
  type Mod = { HEAPU8: Uint8Array; HEAPU32: Uint32Array; VideoDecoder: new (cb: object) => { setCodec(v: string, f: string, e: string): void; decode(d: Uint8Array, key: number, ts: number): void; clear(): void; delete(): void } };
  const ready: Promise<Mod> = (async () => {
    const [glue, wasm] = await Promise.all([
      fetch(env.glueUrl).then((r) => {
        if (!r.ok) throw new Error(`${env.glueUrl}: HTTP ${r.status}`);
        return r.text();
      }),
      fetch(env.wasmUrl).then((r) => {
        if (!r.ok) throw new Error(`${env.wasmUrl}: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    ]);
    // The glue is an ES module (`export default Module;`); a classic Worker takes it as a script.
    const marker = 'export default Module;';
    if (!glue.includes(marker)) throw new Error('unexpected jv4-decoder glue (no default export)');
    const url = URL.createObjectURL(new Blob([glue.replace(marker, 'self.__otterJv4 = Module;')], { type: 'text/javascript' }));
    try {
      (self as unknown as { importScripts(u: string): void }).importScripts(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const factory = (self as unknown as { __otterJv4: (m: object) => Promise<Mod> }).__otterJv4;
    return factory({ wasmBinary: wasm, print: () => undefined, printErr: () => undefined });
  })();

  /** Parameter sets (Annex B) and NAL length size from an avcC / hvcC record. */
  const parseConfig = (hevc: boolean, d: Uint8Array): { prefix: Uint8Array; lengthSize: number } => {
    const nals: Uint8Array[] = [];
    let lengthSize = 4;
    if (hevc && d.length > 22) {
      lengthSize = ((d[21] as number) & 3) + 1;
      let o = 23;
      for (let a = 0, arrays = d[22] as number; a < arrays && o + 3 <= d.length; a++) {
        const count = ((d[o + 1] as number) << 8) | (d[o + 2] as number);
        o += 3;
        for (let i = 0; i < count && o + 2 <= d.length; i++) {
          const len = ((d[o] as number) << 8) | (d[o + 1] as number);
          nals.push(d.subarray(o + 2, o + 2 + len));
          o += 2 + len;
        }
      }
    } else if (!hevc && d.length > 6) {
      lengthSize = ((d[4] as number) & 3) + 1;
      let o = 6;
      for (let i = 0, n = (d[5] as number) & 0x1f; i < n; i++) {
        const len = ((d[o] as number) << 8) | (d[o + 1] as number);
        nals.push(d.subarray(o + 2, o + 2 + len));
        o += 2 + len;
      }
      for (let i = 0, n = d[o++] as number; i < n && o + 2 <= d.length; i++) {
        const len = ((d[o] as number) << 8) | (d[o + 1] as number);
        nals.push(d.subarray(o + 2, o + 2 + len));
        o += 2 + len;
      }
    }
    const prefix = new Uint8Array(nals.reduce((n, x) => n + 4 + x.length, 0));
    let p = 0;
    for (const x of nals) {
      prefix.set([0, 0, 0, 1], p);
      prefix.set(x, p + 4);
      p += 4 + x.length;
    }
    return { prefix, lengthSize };
  };

  /** Length-prefixed NAL units to Annex B, with `prefix` in front. */
  const toAnnexB = (d: Uint8Array, lengthSize: number, prefix: Uint8Array | undefined): Uint8Array => {
    const parts: Uint8Array[] = prefix === undefined ? [] : [prefix];
    let total = prefix?.length ?? 0;
    for (let o = 0; o + lengthSize <= d.length; ) {
      let len = 0;
      for (let i = 0; i < lengthSize; i++) len = len * 256 + (d[o + i] as number);
      const nal = d.subarray(o + lengthSize, o + lengthSize + len);
      parts.push(nal);
      total += 4 + nal.length;
      o += lengthSize + len;
    }
    const out = new Uint8Array(total);
    let p = 0;
    for (const [i, part] of parts.entries()) {
      if (i === 0 && prefix !== undefined) {
        out.set(part, 0);
        p = part.length;
        continue;
      }
      out.set([0, 0, 0, 1], p);
      out.set(part, p + 4);
      p += 4 + part.length;
    }
    return out;
  };

  return {
    async create(config: { codec: string; description?: ArrayBuffer }, out: { frame(f: unknown): void; error(details: string, message: string): void; queue(n: number): void }) {
      const m = await ready;
      const hevc = /^(hvc1|hev1)/.test(config.codec);
      const avcc = config.description === undefined ? undefined : parseConfig(hevc, new Uint8Array(config.description));
      let width = 0;
      let height = 0;
      let index = 0;
      const times = new Map<number, number>();
      const callbacks = {
        videoInfo(w: number, h: number) {
          width = w;
          height = h;
        },
        yuvData(planes: number, idx: number) {
          const ts = times.get(idx);
          times.delete(idx);
          if (ts === undefined || width === 0) return;
          const size = width * height;
          const quarter = (width >> 1) * (height >> 1);
          const y = m.HEAPU32[planes >> 2] as number;
          const u = m.HEAPU32[(planes >> 2) + 1] as number;
          const v = m.HEAPU32[(planes >> 2) + 2] as number;
          const data = new Uint8Array(size + 2 * quarter);
          data.set(m.HEAPU8.subarray(y, y + size), 0);
          data.set(m.HEAPU8.subarray(u, u + quarter), size);
          data.set(m.HEAPU8.subarray(v, v + quarter), size + quarter);
          out.frame({ format: 'I420', width, height, data, timestamp: ts });
        },
        errorInfo(message: string) {
          out.error('decodeError', String(message));
        },
      };
      const decoder = new m.VideoDecoder(callbacks);
      const configure = (): void => decoder.setCodec(hevc ? 'hevc' : 'avc', 'annexb', '');
      configure();
      let closed = false;
      return {
        decode(c: { type: 'key' | 'delta'; timestamp: number; data: ArrayBuffer }) {
          if (closed) return;
          const raw = new Uint8Array(c.data);
          const bytes = avcc === undefined ? raw : toAnnexB(raw, avcc.lengthSize, c.type === 'key' ? avcc.prefix : undefined);
          index = (index + 1) >>> 0;
          times.set(index, c.timestamp);
          decoder.decode(bytes, c.type === 'key' ? 1 : 0, index);
          // Pictures the decoder dropped never come back: forget their numbers.
          if (times.size > 64) for (const k of [...times.keys()].slice(0, times.size - 64)) times.delete(k);
        },
        flush() {
          // The glue has no drain; this build is fed streams without B-frames (cameras) or
          // tolerates losing the reorder tail at the end of a file.
        },
        reset() {
          times.clear();
          decoder.clear();
          configure();
        },
        close() {
          closed = true;
          times.clear();
          decoder.clear();
          decoder.delete();
        },
      };
    },
  };
};
