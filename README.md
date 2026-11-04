# Otter

A pluggable web video player in TypeScript. One call gives a scenario-ready player (VOD, live, low-latency live, DRM, surveillance walls, danmaku (scrolling comments), vertical feeds, TV); underneath, every format, backend, engine, decoder and UI feature is a plugin you can swap or leave out, so a page carries only what its scenario uses. npm scope `@otter-player/*`.

**Status (2026-11-04):** M0–M5 are accepted (core, engines, WebCodecs, own HLS engine, presentation modes, danmaku). M6 (presets, React / Vue / Svelte bindings, TV and vertical-feed input, generated docs) is delivered and its report is open. The 1.0 release is being prepared (ADR-014): no package is published yet; a beta comes first. M7 (real phone and TV regression) follows.

## Install

```bash
npm install @otter-player/presets @otter-player/ui-skin-default
```

React, Vue or Svelte: add `@otter-player/react`, `@otter-player/vue` or `@otter-player/svelte`.

## Quick start

```ts
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

const player = createVodPlayer({ container: document.getElementById('player')!, title: 'Example' });
await player.load('https://example.com/master.m3u8');
```

Each preset is a sub-path (`@otter-player/presets/live`, `/surveillance`, `/shorts`, ...): see `packages/presets/README.md` for the ten presets, the UI language and adding a language.

## Docs

The docs site is generated from the sources (TSDoc, package READMEs, the examples of `e2e/site/examples/`): `pnpm docs:serve` builds it with the example site and serves it under `/docs/`, where every example runs. Public hosting comes with the release (ADR-014).

## Packages

| Group | Packages |
|---|---|
| Assembly | `core`, `presets` |
| Playback session | `media`, `qoe`, `preferences` |
| Backends | `backend-mse`, `backend-native`, `backend-webcodecs` |
| Formats | `format-hls`, `format-dash`, `format-flv`, `format-ts`, `format-mp4-range`, `format-file`, `format-whep` |
| Engine adapters and pipeline | `engine-adapter-hlsjs`, `engine-adapter-shaka`, `engine-adapter-mpegts`, `engine-pipeline`, `pipeline` |
| Decoding | `decoder-webcodecs`, `decoder-wasm-hevc`, `decoder-pool`, `demux-mediabunny`, `decoder-wasm-ffmpeg` |
| Picture and presentation | `surface`, `presentation` |
| Input | `input` |
| UI and skins | `ui-core`, `ui-skin-default`, `ui-skin-minimal`, `ui-skin-tv`, `ui-skin-audio` |
| Captions | `text`, `text-ass` |
| Danmaku and overlays | `danmaku`, `overlay-watermark`, `overlay-thumbnails`, `overlay-ads` |
| Framework bindings | `react`, `vue`, `svelte` |
| Plugins (stubs) | `plugin-analytics`, `plugin-cast`, `plugin-p2p`, `plugin-record`, `plugin-screenshot` |

All are `@otter-player/<name>`, one directory per package under `packages/`.

## Development

Node ≥ 22.18 and pnpm 12.

```bash
pnpm install
pnpm build                 # JS through Vite, d.ts through tsc -b, into packages/*/dist
pnpm typecheck             # strict TS (package sources, tests, scripts)
pnpm test                  # Vitest
pnpm check:boundaries      # package conventions and layer dependency directions
pnpm check:side-effects    # no top-level side effects; every entry (sub-paths too) imports in Node without browser globals (after build)
pnpm check:docs-text       # no control characters in docs/ and the top-level *.md
pnpm check:docs-site       # builds the docs site into docs-site/dist and runs the TSDoc gate (AGENT §4)
pnpm docs:serve            # builds and previews the example site, docs under /docs/
pnpm size                  # size budgets (after build)
pnpm e2e                   # Playwright (after pnpm exec playwright install)
pnpm check                 # every non-e2e check above

node scripts/new-package.ts <name> --description "..." [--deps core,media] [--no-dom] [--css]
```

| Path | Content |
|---|---|
| `packages/*` | the packages |
| `tests/` | cross-package contract tests |
| `e2e/` | Playwright device matrix and axe scans (`e2e/README.md`) |
| `scripts/` | gates and tools (`node scripts/<name>.ts`) |
| `tooling/` | shared build configuration |

## Project documents (Chinese)

| File | Content |
|---|---|
| `SPEC.md` | architecture: engine layer, rendering layer, packages, scenario matrix, milestones |
| `RESEARCH.md` | the web player landscape and the browser pitfalls found (§1) |
| `REUSE.md` | where reused code comes from, reuse levels, vendoring |
| `AGENT.md` | collaboration and engineering rules |
| `docs/decisions/` | ADRs |
| `docs/design/` | UI design, glossary (Chinese / English terms) |
| `docs/reports/` | milestone reports |
| `THIRD_PARTY_NOTICES.md` | sources and licences of vendored or copied code |
| `Assets/icon/` | icon sources and build output |
