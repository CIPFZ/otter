# AGENT.md：Otter 协作规则

本文件面向在本仓库工作的 AI 智能体与开发者。先读 `SPEC.md`，再读 `REUSE.md`，最后读本文件。

## 1. 项目速览

- Otter（工作代号）：100% TypeScript 的通用 Web 播放器，引擎可插拔、可组合、取百家之长。
- 文档：`RESEARCH.md`（生态调研与事实依据）、`SPEC.md`（架构与里程碑）、`REUSE.md`（复用来源、等级、许可证）、`docs/decisions/`（ADR）。
- 当前阶段：M0、M1 已完成（M1 报告见 `docs/reports/M1.md`）；M2 已验收（`docs/reports/M2.md`，ADR-005）；M2.5 视觉系统已交付、待目视验收（`docs/reports/M2.5.md`，ADR-006）；之后进入 M3。工程基线见 ADR-002，引擎契约见 ADR-003，真机与体积口径见 ADR-004。

## 2. 不可违背的约束

1. 语言：TypeScript strict，不引入 Rust / 其他编译到 WASM 的自研代码。WASM 只能是 `decoders/*` 与 `text-ass` 中的第三方产物，独立加载。
2. 引擎可插拔：任何格式、backend、ABR、DRM、Decoder、Renderer、UI 功能都必须以 `SPEC.md` 定义的接口接入。不得让 `core` 依赖任何具体实现。
3. 分层纪律：UI / Overlay / Presentation 只读 store、只派发 action，禁止直接操作引擎或 `<video>`。
4. 用户手势：全屏、PiP、横屏锁、带声自动播放必须在同一事件回调内同步调用。
5. 体积预算是验收项（见 `SPEC.md` §1.1、§19），超预算的提交不算完成。
6. 真机矩阵：iPhone Safari、Android Chrome、桌面 Chrome/Firefox/Safari、至少一台 Tizen 或 webOS。只在桌面 Chrome 测过的播放器功能视为未完成。M1–M5 阶段以桌面三大浏览器真机 + CI 上的 WebKit 与模拟移动端为准，手机与 TV 真机在 M5.5「移动端真机回归」一次性补跑（ADR-004）。
7. 引擎库（hls.js / Shaka / mpegts.js / WASM 解码器）只能按需以 chunk 加载，不得进入首屏；SPEC §19 的「自有代码」体积是 M1–M5 门禁（ADR-004）。

## 3. 复用与许可证规则

- 复用前先在 `REUSE.md` 查来源与等级；没列出的来源先补表再用。
- 四级：L1 依赖 / L2 子包 vendoring / L3 文件级复制 / L4 只借设计。
- 许可证：
  - Apache-2.0、MIT、BSD：L1–L4 全部允许，保留声明。
  - LGPL（libmedia、FFmpeg、libass、libde265）：仅 L1，独立 WASM / 动态模块，源码不进核心。
  - GPLv3（Jessibuca 开源版、EasyPlayer 部分组件）：仅 L4。禁止读源码后照抄，禁止相似结构。
  - 闭源（B 站 nano、TCPlayer、Aliplayer、THEO、Bitmovin、JW、IVS）：只观察行为与 API 形状，不反编译、不抓包还原协议。
- vendored 文件必须有头部来源标记 `// Derived from <project>@<commit> <path>, <license>`，目录下有 `UPSTREAM.json`，根目录 `THIRD_PARTY_NOTICES.md` 同步更新。
- CI 的 license 门禁失败即阻断。

## 4. 工程约定

- 包管理 pnpm，构建 Vite，单测 Vitest，E2E Playwright，无障碍 axe。
- `tsconfig`：`strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`。
- 全 ESM，每个包 `sideEffects: false`，禁止顶层副作用。唯一例外是纯 CSS 皮肤包 `ui-skin-*`：声明 `"sideEffects": ["*.css"]`，包内禁止任何 `.js` / `.ts` 入口、源文件与 tsconfig，`exports` 只能指向 `.css`（ADR-002 第 10 条，由 `check-boundaries` 与 `check-side-effects` 强制）。
- 工具链新主版本在里程碑中阻塞超过一天即退回上一 LTS 主版本，回退单独提交并记入 ADR-002（第 11 条）。
- 公开 API 用 `interface`；内部可用 class。
- 二进制：`ArrayBuffer` 走 Transferable；热路径用对象池；禁止在 demux/remux 中创建闭包。
- 错误：统一错误模型（`SPEC.md` §4），禁止吞错；每个 fatal 错误必须附降级路径。
- 事件：类型安全总线，禁止字符串拼接事件名。
- 命名：包名 `@otter-player/<name>`，Web Components 前缀 `otter-`，CSS 变量前缀 `--otter-`，事件前缀无（用类型约束）。
- 新包一律用 `node scripts/new-package.ts` 生成；包内相对导入带 `.js` 扩展名（NodeNext）。
- 未实现的能力统一抛出 / reject `notImplemented`（非 fatal），不得静默 no-op（ADR-002）。
- 提交前跑 `pnpm check`：license 门禁、边界、strict TS、Vitest、无顶层副作用、体积预算，任何一项失败都阻断。

## 5. 工作流程

1. 任何新能力先问三件事：属于哪个包；接口是否已在 `SPEC.md`；来源与等级是否已在 `REUSE.md`。缺一项先补文档再写代码。
2. 先适配后替换：HLS/DASH/DRM 先走 hls.js / Shaka / mpegts.js 适配器，QoE 有数据后再决定替换。
3. 直接在 `main` 上小步提交并推送，保持 CI 绿；每个里程碑在 `docs/reports/Mx.md` 附：体积报告（size-limit）、真机矩阵结果、axe 结果、license 门禁结果。
4. 遇到浏览器差异先查 `RESEARCH.md` §1 与 `SPEC.md` §15 的坑表；新发现的坑追加到表里。
5. 决策变更写 ADR（`docs/decisions/ADR-xxx.md`），格式参照 ADR-001。

## 6. 明确不做

- 不做服务端（打包、转码、许可证服务器、P2P tracker）。
- 不做 Roku、Flash 回退、IE。
- 不支持 VVC/H.266。
- 不自写 EME/DRM 流程、不自写解码器。
- 不在 `core` 中引用 DOM 类型。

## 7. 测试资产

- hls.js `tests/test-streams.js`、Shaka `demo/common/assets.js`、DASH-IF 参考流作为公开测试源起点。
- 本地测试源用 ffmpeg / Shaka Packager 生成 CMAF（cbcs）双清单样本。
- 弹幕性能基准：5000 条/分钟 60fps。
- 监控基准：16 路 720p HEVC。

## 8. 开放问题跟踪

见 `SPEC.md` §23。任何开放问题有结论后写 ADR 并从 §23 移除。
