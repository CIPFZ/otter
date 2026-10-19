# @otter-vendor/hls.js (L2)

hls.js' MPEG-TS demuxer and fMP4 remuxer, copied at `e5ff358` (v1.7.3) for Otter's own pipeline (ADR-007 §1). Private workspace package: `@otter-player/pipeline` pre-bundles it, and it is never published.

- Every copied file starts with `// Derived from hls.js@<commit> <path>, Apache-2.0`; the list of copied files and every local change is in `UPSTREAM.json`.
- `src/otter/` and `src/index.ts` are Otter's own files: the shims that replace hls.js' event bus, config and logger, and the entry point.
- Upstream drift: `node scripts/vendor-sync.ts` (CI weekly). Record each review in `UPSTREAM.json` `syncLog`.
- Re-sync: copy the upstream file, reapply the import rewrite to `src/otter/shims.js`, then run `node scripts/vendor-strictify.ts vendor/hls.js/tsconfig.json --write` and finish the remaining strict errors by hand. Tests: `pnpm vitest run vendor`.
