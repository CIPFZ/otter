# Bugzilla draft (the owner files it): main-thread rAF stops ~10 s while a Worker reads back a 2D OffscreenCanvas and draws WebGL to a transferred canvas

Product: Core · Component: Graphics: Canvas2D (or Graphics: CanvasWebGL / DOM: Workers — triage)
Firefox: 159.0 release, Windows Server 2022 (RTX 3080, driver 32.0.15.6094) and Linux x86_64 (Xvfb, software GL)

## Summary

A page transfers a `<canvas>` to a dedicated Worker (`transferControlToOffscreen`) and the Worker
draws it with WebGL2 every frame (one draw per main-thread rAF, posted with `postMessage`). For each
new sprite the Worker also paints text on a separate `OffscreenCanvas` 2D context and reads it back
with `getImageData()`, then uploads the pixels with `texSubImage2D`. In most runs, the page's
`requestAnimationFrame` stops once for almost exactly 10 s (9 999 – 10 017 ms) and then resumes; while
it is stopped, script on the main thread does not run either (WebDriver `page.evaluate` times out).

## Steps to reproduce (current reproduction: the Otter player's danmaku Worker renderer)

1. `git clone https://github.com/CIPFZ/otter && cd otter && git checkout 986f24e` (the last revision
   before the workaround). In `packages/danmaku/src/policy.ts`, make `rendererBlocked()` return
   `undefined` (that revision refuses the Worker renderer on Firefox because of this bug).
2. `pnpm install && pnpm build`, then `OTTER_BENCH=1 pnpm exec playwright test e2e/danmaku-bench.spec.ts --grep "on worker"` with a project using `channel: 'moz-firefox'`, headed.
3. The bench plays an HLS clip in a `<video>`, adds ~5000 comments per minute, and measures the
   page's rAF intervals for 10 s.

## Actual

| Run (Linux, release 159.0) | page rAF p50 | page rAF p95 | gaps > 50 ms |
|---|---|---|---|
| as is, 5 runs | 17.1 ms | ~10 000 ms in 4 of 5 | 1–2 |
| Windows, as is, 3 runs | 16.7 ms | ~10 000 ms in 3 of 3 | — |

The Worker's own frames continue (its frame interval p95 22–24 ms).

## Expected

rAF keeps ~16.7 ms (Chrome / Edge / Safari do; Firefox does with the change below).

## Isolation (Linux, each row 3–5 runs)

| Change in the Worker | Stall |
|---|---|
| none | 4 / 5 |
| text not painted (empty sprite still read back + uploaded) | 2 / 3 |
| no sprites at all (no getImageData, no texSubImage2D; WebGL still draws every frame) | 0 / 3 |
| getImageData kept, texSubImage2D removed | 1 / 3 |
| getImageData without `willReadFrequently` | 4 / 5 |
| **no getImageData: each sprite painted on its own OffscreenCanvas, `texSubImage2D(…, canvas)`** | **0 / 5** (Windows 0 / 5) |

So the trigger is `OffscreenCanvasRenderingContext2D.getImageData()` in a Worker that also renders
WebGL to a canvas transferred from the page; the readback is enough without the upload.

## Not yet a standalone test case

A page with the same structure (transferred canvas, WebGL2 draw per rAF, sprites painted on one
reused 2D OffscreenCanvas and read back with getImageData, with or without a playing `<video>`)
did **not** stall in 12 runs (attached: `index.html`, `worker.js`, `run.mjs`, mode `webgl-readback`).
Something else in the real page is still needed; candidates not yet removed: the HLS `<video>` on
MSE, the atlas size (4096²), the `Float32Array` transferred each frame, the main-thread DOM overlay.

## Workaround (shipped in Otter after 986f24e)

Upload sprites straight from an OffscreenCanvas (no `getImageData` in the Worker).

## Attachments to add when filing

- The standalone page that does not reproduce: `docs/reports/m6/f4-standalone/` (`index.html`,
  `worker.js`, `run.mjs`; `node run.mjs <playwright-core dir> <video.mp4> [firefox]`, mode
  `webgl-readback`).
- Bench notices of the runs in the isolation table.
