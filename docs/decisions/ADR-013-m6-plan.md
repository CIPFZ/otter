# ADR-013：M6 批次与范围（presets、绑定、SSR、文档站、体积收口）

- 状态：已采纳
- 日期：2026-10-27
- 关联：`SPEC.md` §1.1、§19、§21、§23 Q1；ADR-004（体积口径）、ADR-010 §3（自研 HLS 引擎体积）、ADR-012（弹幕）；`docs/reports/M5.md`「M5 → M6 交接」

## 背景

M5 于 2026-10-27 关闭。负责人按「M5 → M6 交接」定了 M6 的四批顺序和 Q1。M6 的验收（SPEC §21）是两条：体积预算全部达标（含 Hero < 5 KB），以及文档站上线。

## 决定

### 1. Q1 结案

- 名称 Otter 不改，npm scope `@otter-player/*` 不改。
- 改名清单（交接 §8）只备案，不执行。
- 发布前仍要核验这个 scope 在 npm 上是否被占用。

### 2. 批次（每批一到三项一停，四段汇报，报告 `docs/reports/M6.md`）

| 批 | 内容 | 依据 |
|---|---|---|
| 一 | **core 三样补丁**：服务端快照（`getInitialState` / server snapshot）、监听隔离（一个监听抛错不打断 `setState` 与其他监听）、`destroy` 清掉 store 的监听。**自研 HLS 全部块压回 15 KB**：先把门禁改成 15 KB，再按交接 §3 的候选 1–3 动代码：SPF 解析器去掉交给 hls.js 的分支、EWMA 换成双 EWMA 函数、mse-sink 的账本与 `abort()` 拆成按需块 | 交接 §3、§6；ADR-010 §3 |
| 二 | **Hero preset**：按交接 §2 的拆法（store + `observeMediaElement`，不走会话），≤ 5 KB 进门禁。**`createPlayer` 与九个 preset**：vod、live、lowlatency、ott-drm、surveillance、danmaku、shorts、tv、background，每个 preset 对应一个 §19 场景的体积条目 | 交接 §1、§2、§4 |
| 三 | **React / Vue / Svelte 绑定**：只依赖 `getState` / `subscribe` / `dispatch`。**SSR**：52 个入口导入安全保持不变；三处调用时碰 window 的地方加守卫（imsc 的 TTML 路径、Shaka / mpegts.js 引擎的创建、不传 registry 的 `defineElements()`）；`check-side-effects` 补上顶层 `class extends`（DOM 类）和 sub-path 入口的检查 | 交接 §5、§6 |
| 四 | **`ui-skin-tv` 与遥控器输入**（焦点管理、方向键映射）；**shorts preset 的竖屏手势**；**文档站**：按交接 §7 的 API 面从源码自动生成 | 交接 §4、§7 |

- SPEC §21 的「多宫格每路独立记住放大与滤镜」不在以上四批里，等四批完成后与负责人确认放在哪一批。

### 3. 体积口径

- 自研 HLS 引擎全部块从 16.5 KB 回到 15 KB，第一批第一步就改门禁，ADR-010 §3 随之修订。
- Hero 从 M6 第二批起进门禁（≤ 5 KB），不再只报告。
- §19 的「含引擎」列随 preset 定稿改口径：默认引擎是自研的（HLS、FLV / TS），按自研块计；第三方引擎单列为回退或不支持的流。

### 4. preset 与 §19 体积条目（第二批，2026-10-27）

- 每个 preset 是 `@otter-player/presets` 的一个 sub-path（`/vod`、`/live`、`/background`……），页面只带自己场景的格式与后端。主入口导出 `createPlayer`。
- 体积条目量的是宿主导入的 preset 本身：
  - 长视频点播行 = `vod`；
  - 直播行 = `live`；
  - Hero 行 = `background`，从第二批起门禁 ≤ 5 KB。
- 其余 preset（lowlatency、ott-drm、surveillance、danmaku、shorts、tv）随第二批后续各停接上各自的行。
- 没有对应 preset 的行（短视频 / 简单点播、国内直播 / 电商）保留原来的组合。

### 5. 「含第三方引擎」列的口径（2026-10-28 负责人）

- 只计首播必须加载的块：该场景默认首播走的引擎块。HLS 默认是自研引擎块，FLV / TS 默认是自研管线块；第三方引擎只在它就是默认引擎时计入，例如 DASH 的 Shaka。
- 按需块单列，不计入：字幕、缩略图、放弃、直播、弹幕的 WebGL / Worker / 蒙版、编码探测等。
- WebCodecs 路径专用的块不计入（mediabunny、WASM 解码器等）。
- 数字等 preset 全部定稿后统一重量；在那之前，报告列维持现状，并标明「旧口径」。

### 6. 第二批收尾的顺序（2026-10-28 负责人）

先做测试收口轮（M6.md）。之后第二批收尾一起做：
- `presets/basic`：短视频行，外壳只有播放 / 暂停、静音、时间、进度条、全屏；默认格式是 mp4-range 加自研 HLS 点播块；可以经 slices / plugins / setup 扩展；≤ 30 KB。
- 字幕与缩略图改为按需块。
- ott-drm、surveillance、shorts 三个 preset，并补上 OTT、监控、剪辑三行。

### 7. 监控行的格式（2026-10-30 负责人）

- FLV 进 1.0：在 pipeline / transmux 的 FLV 解析上开一个样本出口，实现 WebCodecs 后端的 Demuxer 接口（流式、直播、音视频都出），复用 param-sets 的 AVC / HEVC 参数集处理；fMP4（MSE）路径不动。surveillance 的 streams 支持 http(s)-flv 与 ws-flv，路由偏向 WebCodecs。
- TS 视 mediabunny 而定：先验证它对流式 MPEG-TS（HTTP 分块、无限长）的支持，限半天；能流式就接进 surveillance，不能则记为 1.0 之后的已知限制，不自研。
- PS 不进浏览器：经网关转 FLV。
- 排期：「F4 根因 + WebKit 暂停 seek 不刷新」那一停之后、第三批之前，单独一停；不扩到 PS，不扩到 MSE 路径。e2e 用 `/live/stream.flv` 夹具 4 路进多宫格（TTFF、丢帧按现有口径），真 Edge 16 路各 5 次；监控行重量，只记录。
- 收尾（c93d22f 验收，2026-10-30 负责人）：
  - WebCodecs 的 FLV / TS 解复用器只用于直播：格式插件只对 `live: true` 的源提供 webcodecs，`createDemuxer` 拒绝点播源（`liveOnly`）；偏好 WebCodecs 的点播地址回落 MSE。**点播 FLV / TS 走 WebCodecs 不在 1.0。** surveillance 把 FLV / TS 源标为直播，源自己写了 `live: false` 的除外。
  - 首帧口径进 SPEC §19 的注并判定：单路 FLV 中位数 ≤ MSE 参照 + 300 ms，直播 TS ≤ 1 s，16 路每路 ≤ 3 s。
  - 预热（半天时间盒）：surveillance 创建时让解码池按路数起 Worker 并先载入解码代码（`Decoder.warm()`、`DecodePool.warm()`），不等 `load()`。本地一路首帧中位数 Chrome 82 → 78 ms、Firefox 128 → 109 ms，四路 Chrome 99 → 92 ms、Firefox 156 → 126 ms（各 16 / 64 个样本）；有效但小，进产品。worklet 不预热：它要 AudioContext，而无手势时不建上下文（ADR-008 F1）。
  - 同一来源超过 6 路 HTTP(S) 直播流：第 7 路起各发一条非致命错误 `tooManyConnectionsPerHost`（浏览器每主机 6 个 HTTP/1.1 连接，直播流一直占着；HTTP/2 不受限，但页面看不出来，所以只是警告）。

## 代价

- 体积收口要动 SPF 的 L3 拷贝（候选 1）。本地改动变多，UPSTREAM.json 要记清楚，以后同步上游时要合并。
- EWMA 换掉后，hls.js 的 `ewma.ts` 从 L3 改为 L4（只借设计，REUSE 改记录）。
