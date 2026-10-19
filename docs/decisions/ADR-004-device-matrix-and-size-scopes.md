# ADR-004：真机矩阵分阶段、体积口径拆分

- 状态：已采纳
- 日期：2026-10-16
- 关联：`SPEC.md` §1.1、§19、§21；`AGENT.md` §2；ADR-002、ADR-003；`docs/reports/M1.md`

## 背景

1. M1 验收中「真机矩阵至少在一台 iPhone 与一台 Android 上实际跑过」没有满足，原因是没有手机端点。其余验收项都已完成，包括 Windows Edge 真机（`docs/reports/M1.md`）。每个里程碑都要求手机真机，等于里程碑卡在设备资源上，而不是卡在代码上。
2. SPEC §19 的场景体积目标（如「长视频点播 < 80 KB」）是按自研轻量引擎写的。M1–M5 按「先适配后替换」使用 hls.js / Shaka / mpegts.js（L1），单 hls.js 就有 183.5 KB（gzip），这些目标在 M6 之前不可能达到。如果不拆开口径，体积门禁要么形同虚设，要么永远是红的。
3. 夜间运行的 `@network` 公网场景失败时（实测原因主要是公网测试源与测试机的网络质量），只在 Actions 页面可见，没人跟踪。

## 决策

### 1. 真机矩阵分阶段

- **M1 视为验收通过。**「真 iPhone + 真 Android」从 M1 的阻塞项改为延后项，在 `docs/reports/M1.md` 中如实标注。
- **M1–M5 的真机要求统一为**：桌面 Chrome / Firefox / Safari 真机，加上 CI 上的 WebKit 与模拟移动端（`desktop-safari`、`emulated-iphone`、`emulated-android`）。桌面真机包括已接入的 `real-windows-edge`（Edge 为 Chromium 内核，计入桌面 Chrome 一项）。
- **新增里程碑 M5.5「移动端真机回归」**，排在 M6 之前：真 iPhone Safari、真 Android Chrome，至少一台 Tizen 或 webOS（AGENT §2.6 原要求不变），一次性补跑 M1–M5 的全部场景与全部模式，逐条记录结果。发现的问题在该里程碑内修完，M6 才能开始。
- `emulated-*` 仍然不能当作真机结果，报告中照旧单独列出。
- AGENT §2.6「只在桌面 Chrome 测过的播放功能视为未完成」不变：M1–M5 至少要过桌面三大浏览器和 CI WebKit。

### 2. 体积口径

- SPEC §19 的体积目标拆成两列：
  - **自有代码**：该场景**首屏**加载的 Otter 代码，以及首屏静态引入的非引擎 L1 依赖；不含第三方引擎库，也不含任何经 `import()` 按需加载的块（ABR 规则栈与引擎胶水、CMCD、字幕解析器等）。原表中的数字全部归入这一列，作为 **M1–M5 的门禁**，超出即 CI 失败。按需块在 size-limit 报告中逐个单列（「on-demand chunk」），只记录不门禁；它们会随功能出现在报告与 job summary 中，变化可见。
  - **含第三方引擎**：在自有代码基础上，再加该场景首次播放必须加载的引擎块。**M6 之前只记录、不门禁**，size-limit 报告里照常列出。
- **M6 的「简单点播 < 30 KB」按含引擎口径计算**，即自研轻量 CMAF-HLS 引擎替换 hls.js 之后的总量。
- **新增规则：引擎库只能按需以 chunk 加载，不得进入首屏。** hls.js、Shaka、mpegts.js，以及以后的 WASM 解码器，只能在 `Engine.load()` / `Decoder.create()` 中通过 `import()` 加载。CI 用两条规则检查：
  - `check-side-effects` 已经把第三方模块当作 external，任何对引擎库的顶层静态 import 都会被判失败；
  - 新增 `check-engine-chunks`：构建场景入口，断言引擎库不在首屏 chunk 里。
- 自有代码列的门禁以 size-limit 的场景条目实现（`tooling/size/scenario-*.js`）：esbuild 插件把所有 `import()` 目标标为外部，量出的就是首屏；每个场景条目都设上限。（2026-10-19 修订：原写法用 `ignore` 只排除引擎库，CMCD 落地后发现 size-limit 不做代码分割，会把按需块内联计入首屏。）
- 例外：「背景视频 / Hero < 5 KB」（无 UI、只播原生 mp4）指的是一个专用的极简 preset，按 SPEC §21 在 M6 随 presets 发布。在此之前，用通用组合（播放会话 + 选路，当前 8.6 KB）只记录、不门禁，M6 起门禁。其余 §19 场景在 M1 的组合下自有代码均已在目标以内（14.8–17.1 KB），即刻门禁。

### 3. 夜间 `@network` 失败自动建 Issue

- 夜间（`schedule`）任务中 `@network` 场景失败时，CI 自动创建一个标题固定的 Issue「Nightly @network scenarios failing」；如果已有同标题的 open Issue，就在其中追加评论（运行链接、失败用例、时间）。用的是 `GITHUB_TOKEN`，权限仅 `issues: write`。
- 该任务失败不阻断主线 CI（PR / push 本来就不跑 `@network`）。
- 恢复成功后不会自动关闭 Issue，由人确认根因（网络还是产品）后手动关闭。

## 代价与风险

- 手机端的问题（iPhone MMS、伪全屏、横屏锁、Android 硬解差异）会集中到 M5.5 才暴露。M3 的 presentation 全模式（尤其 iPhone 伪全屏）在此期间只有 WebKit 模拟的覆盖，返工风险集中在 M5.5。缓解办法：M3 继续保留 WebKit 的「仅 MMS」与触控模拟用例，并在设计上严格按 RESEARCH §1 与 SPEC §15 的坑表实现。
- 体积按两列记录后，含引擎一列在 M6 之前可能持续变大而无人察觉。缓解办法：size-limit 报告每次都在 CI 的 job summary 中列出含引擎数字，变化随 PR 可见。
