# @otter-vendor/mpegts.js (L2)

mpegts.js' FLV demuxer, ported from JavaScript to strict TypeScript at `791bac8` (v1.8.2) for Otter's own pipeline (ADR-007 §1). Private workspace package: `@otter-player/pipeline` pre-bundles it, and it is never published.

- Scope: the FLV container, AMF script data, H.264 / H.265 and AAC. Enhanced FLV Opus / FLAC / AV1, MP3, PCM and SEI are not copied; streams that use them stay on the mpegts.js adapter.
- Every copied file starts with `// Derived from mpegts.js@<commit> <path>, Apache-2.0`; `UPSTREAM.json` lists the files and every local change, including one upstream bug fix (AAC config comparison).
- `src/otter/` and `src/index.ts` are Otter's own files.
- Re-sync: diff the upstream JS against the pinned commit (`node scripts/vendor-sync.ts`), port the change into the TS file by hand, and keep `pnpm vitest run vendor` green.
