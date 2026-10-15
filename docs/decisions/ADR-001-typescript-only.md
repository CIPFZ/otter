# ADR-001：实现语言为纯 TypeScript，WASM 仅作为可选解码器边界

- 状态：已采纳
- 日期：2026-10-15
- 关联：`SPEC.md` §1.2、§2；`REUSE.md`

## 背景

用户既有项目（Inkra、Fennec、Trellia、Ambra）遵循"100% Rust"约定，Marmot 已是一次例外（纯 Swift）。Otter 是 Web 播放器，用户明确表示不想用 Rust，希望直接用 JS / TS 开发。

## 决策

1. 核心、引擎、渲染、UI 全部使用 TypeScript（strict），不引入 Rust 工具链。
2. WASM 只出现在可选 `decoders/*` 与 `text-ass` 包中，消费现成产物（libde265、ffmpeg.wasm、libass），以独立模块加载，不进核心。
3. 不自写解码器，不自写 EME/DRM 流程。

## 理由

- 浏览器播放器的重活（解码、渲染、A/V 同步）由浏览器完成，JS 层做拉流、解析、解封装、转封装、ABR、缓冲与 UI。hls.js 在 Worker 里用纯 JS 做了十年，TS 分片转 fMP4 每片仅几毫秒，无性能理由上 Rust。
- 业界事实：hls.js、Shaka、dash.js、mpegts.js、video.js v10、Vidstack、RxPlayer、libmedia 全是 TS。
- Rust/WASM 在 Web 播放器里只有两个合理用途：软解码器兜底、像 Twitch/IVS 那样保护 IP 并复用到原生端。前者消费现成 WASM 即可，后者不是目标。
- "集百家之长、直接 copy 可用代码"的策略要求与生态同语言，TS 让 L1–L3 复用成本最低。

## 代价

- 与用户其他 Rust 项目的工具链不一致；本项目是独立例外。
- 若未来要把核心逻辑复用到原生端（iOS/Android），需另起方案。

## 工程纪律（随本决策生效）

- 核心包零 DOM 依赖，管线可运行于 Worker。
- 全 ESM、`sideEffects: false`。
- 二进制数据走 Transferable 与 ArrayBuffer 池。
- strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`。
- 公开 API 以 `interface` 定义。
