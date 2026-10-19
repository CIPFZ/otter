# Otter REUSE：复用来源、等级与许可证

- 日期：2026-10-15
- 原则：不从零开始，集百家之长；好的代码能 copy 就 copy，但分级、留痕、合规。
- 关联：`SPEC.md` §20、`AGENT.md` 许可证规则

## 1. 复用四级

| 等级 | 做法 | 适用 | 成本 |
|---|---|---|---|
| L1 依赖 | npm 直接装，用适配器包一层 | 成熟且体积可接受的整块：hls.js、Shaka、mpegts.js、imscJS、mp4box.js、mediabunny | 最低，升级跟社区 |
| L2 子包 vendoring | 把对方 monorepo 里独立子包整体拷进 `vendor/`，保留 LICENSE 头，自行维护 | 对方不单独发布但独立性强的部分：hls.js 的 `demux/` 与 `remux/`、xgplayer 的 transmuxer、video.js v10 的 UI 原语、Media Chrome 元素 | 低，但要定期 diff 上游 |
| L3 文件级复制 | 拷单个文件或函数，改命名空间与类型 | 工具函数、算法：EWMA 带宽估计、BOLA、codec 解析、VTT 解析、手势识别、伪全屏特判 | 低 |
| L4 只借设计 | 读源码，按自己接口重写 | 架构与状态机：video.js v10 三层、Shaka DRM 抽象、mpegts.js 看门狗、Jessibuca 降级链、B 站蒙版弹幕 | 中，无许可证包袱 |

## 2. 许可证红线

| 许可证 | 代表项目 | 允许等级 |
|---|---|---|
| Apache-2.0 | hls.js、Shaka、video.js、flv.js、mpegts.js、Vidstack、RxPlayer、imscJS、media-chrome、vtt.js、`@svta/common-media-library` | L1–L4，保留 NOTICE 与头部声明 |
| MIT | xgplayer、ArtPlayer、DPlayer、Plyr、mp4box.js、mediabunny、CommentCoreLibrary、`danmaku`（weizhenye）、`media-captions`、yuv-canvas、webcodecsfundamentals 示例 | L1–L4 |
| BSD-3 / BSD-2 | dash.js、imscJS | L1–L4，保留声明 |
| ISC | Lucide（图标，含源自 Feather 的 MIT 部分）、sax | L1–L4，保留声明 |
| LGPL | libmedia、FFmpeg 构建、libass、libde265 | 仅 L1，且以独立 WASM / 动态模块加载，源码不进核心 |
| GPLv3 | Jessibuca 开源版、EasyPlayer 部分组件 | 仅 L4，禁止看完照抄，相似结构也不行 |
| 闭源 | B 站 nano、腾讯 TCPlayer、阿里 Aliplayer、THEO、Bitmovin、JW、IVS | 只观察行为与 API 形状，不反编译 |

CI 门禁（`scripts/license-gate.ts`，策略表在 `scripts/license-policy.ts`，两处同步修改）的判定：

- 运行时依赖只允许 Apache-2.0、MIT、BSD-2-Clause、BSD-3-Clause，以及与 MIT 等价的 ISC、0BSD。
- 仅限开发工具链（devDependencies 依赖树，不随产物发布）：MPL-2.0、CC0-1.0、CC-BY-3.0/4.0、BlueOak-1.0.0、Python-2.0、Unlicense、MIT-0、Zlib。
- LGPL 只允许出现在 `decoder-*` 与 `text-ass` 的运行时依赖中；GPL / AGPL / SSPL 等在任何位置都失败；缺失或不符合 SPDX 的许可证必须在策略表中显式 override 并写明理由。

## 3. 引擎层来源清单

| 模块 | 来源 | 等级 | 要改什么 |
|---|---|---|---|
| HLS 完整引擎 | hls.js | L1 适配器 | 包成 `EngineAdapter`，只暴露 `MediaBackend` 事件。M1 接入：`engine-adapter-hlsjs` 依赖 `hls.js@1.7.3`，`load()` 内动态 `import()` |
| DASH 引擎 + DRM + 离线 | Shaka Player | L1 适配器 | 同上；DRM 配置映射 Shaka `drm.servers`。M1 接入：`engine-adapter-shaka` 依赖 `shaka-player@5.2.13`（DASH，以及带 DRM 的 HLS） |
| FLV / TS 直播引擎 | mpegts.js | L1 起步，后期 L2 `demux/flv-demuxer`、`demux/ts-demuxer`、`remux/mp4-remuxer` | 自研管线时拷 demuxer 改成 `Demuxer` 接口。M1 接入：`engine-adapter-mpegts` 依赖 `mpegts.js@1.8.2`。M3：FLV demuxer 以 L2 拷入 `vendor/mpegts.js/`（mpegts.js@791bac8，JS 移植为严格 TS；只保留 FLV 容器、AMF、H.264 / H.265、AAC；修正了上游 AAC config 比较的 bug，ADR-007 §1）。TS demux 与 remux 用 hls.js 的拷贝 |
| TS → fMP4 转封装 | hls.js `src/demux/tsdemuxer.ts` + `src/remux/mp4-remuxer.ts` + `mp4-generator.ts` | L2 | 去掉事件总线耦合，改纯函数。M3 已复制到 `vendor/hls.js/`（私有 workspace 包 `@otter-vendor/hls.js`，hls.js@e5ff358，ADR-007 §1）；事件总线、config、logger 换成 `src/otter/shims.ts`；SAMPLE-AES 与 AC-3 未复制；严格 TS 由 `scripts/vendor-strictify.ts` 机械处理加人工收尾 |
| MP4 分段加载（Range + moov） | xgplayer `xgplayer-mp4` + mp4box.js | L2 / L1 | 分段策略 + box 解析拼成 `format-mp4-range` |
| 通用 demux（MP4/WebM/MKV）给 WebCodecs | mediabunny（MIT，TS，无依赖） | L1 | 直接出 `EncodedVideoChunk` |
| ABR 带宽估计 | hls.js `src/utils/ewma-bandwidth-estimator.ts` + `src/utils/ewma.ts` | L3 | 几十行直接拿。M2 复制到 `packages/pipeline/src/vendor/hls.js/`（hls.js@e5ff358 = v1.7.3） |
| ABR 规则 | dash.js `BolaRule`、`ThroughputRule`、`InsufficientBufferRule` | L3 | 改成规则叠加接口。M2 复制到 `packages/pipeline/src/vendor/dash.js/`（dash.js@a9a8542 = v5.2.1，BSD-3，保留许可证全文） |
| Codec 字符串解析与 MediaCapabilities | hls.js `src/utils/codecs.ts` + `mediacapabilities-helper.ts` | L3 | 直接拿 |
| MSE 操作队列与配额驱逐 | hls.js `buffer-operation-queue.ts` + `buffer-controller.ts` flush 逻辑 | L3 | 拆出纯操作队列 |
| MMS 适配（AirPlay 条件、start/endstreaming） | hls.js `buffer-controller.ts`、`utils/mediasource-helper.ts` | L3 | 直接拿。M1 已复制到 `packages/backend-mse/src/vendor/hls.js/`（hls.js@e5ff358 = v1.7.3） |
| 直播追帧 / 动态倍速 / 看门狗 | mpegts.js `mse-controller.ts` + `player/mse-player.ts` stall 检测 | L3 | 抽成 `LiveController`。M3：`player/live-latency-chaser.ts`、`live-latency-synchronizer.ts`、`startup-stall-jumper.ts` 改写为纯函数，放在 `packages/pipeline/src/vendor/mpegts.js/`（mpegts.js@791bac8）；Otter 自己的策略（目标延迟、尊重用户倍速、回到直播）在 `pipeline/live` |
| CMCD | `@svta/cml-cmcd`（SVTA common-media-library monorepo 的拆分包，Apache-2.0） | L1 | 直接用。伞包 `@svta/common-media-library` 停在 0.18.1（2025-10），改用拆分包 2.8.2（ADR-005 §2）；对等依赖 `@svta/cml-structured-field-values`、`@svta/cml-utils` |
| Content Steering | hls.js `content-steering-controller.ts` | L3 | 后期 |
| HLS 清单解析（自研轻引擎用） | hls.js `m3u8-parser.ts` 或 `m3u8-parser`（video.js 系） | L3 | 均 Apache |
| DASH MPD 解析 | `mpd-parser`（video.js 系） | L1 | 独立 npm 包 |
| WHEP 客户端 | `@eyevinn/whep-video-component` 或 Cloudflare WHEP 示例（MIT） | L3 | 约百行 |
| WebCodecs 播放循环 | webcodecsfundamentals.org 示例（MIT）+ libmedia 架构 | L3 / L4 | 示例可拷，libmedia 只看设计 |
| HEVC WASM 软解 | libde265.js 构建产物 / ffmpeg.wasm 定制（LGPL） | L1 独立加载 | 可选 Decoder 插件，不进核心 |
| EME 流程 | Shaka `drm_engine` | L4 | 仍建议 L1 用 Shaka |
| 测试流清单 | hls.js `tests/test-streams.js`、Shaka `demo/common/assets.js`、DASH-IF 参考流 | L3 | 省下搭测试源。M1 已复制子集到 `e2e/vendor/hls.js/`、`e2e/vendor/shaka-player/` |

## 4. 渲染层来源清单

| 模块 | 来源 | 等级 | 说明 |
|---|---|---|---|
| State store 与 features 组合 | video.js v10 `@videojs/core`（zustand 风格 slices） | L2 或 L4 | GA 后 L2；RC 期间 L4 自写同形状（见 SPEC Q2） |
| 无样式 UI 原语 | video.js v10 原语 / Media Chrome `media-*` 元素 | L2 | Media Chrome 已稳定可直接 vendoring，其 `MediaController` 状态桥接是 Chrome 层参考实现 |
| 默认皮肤与布局 | Vidstack default layout CSS | L4 | 只借布局与交互设计，按 `otter-*` 原语与 `--otter-*` 变量重写（原计划 L2，因其 CSS 与 Vidstack 元素 / data 属性强耦合而改为 L4，ADR-005 §6） |
| 图标集 | Lucide（ISC，npm `lucide`） | L1 | M2.5 起（UI-DESIGN §5，ADR-006）。24 px 网格、2 px 线性描边；Lucide 缺的媒体图标（live 点、spinner、剧场）在 `ui-core/src/icons.ts` 按同样网格自绘。`ui-core` 构建时把用到的图标预打包进 dist（`otter.bundle`），消费方按元素 tree-shake |
| 无障碍清单与键盘模型 | Vidstack a11y 文档与 `MediaKeyboardController` | L3 | 快捷键映射表直接拿。CVAA 清单逐条进 `docs/reports/M2.md` |
| 手势识别 | xgplayer `mobile` 插件、ArtPlayer `gesture` | L3 | MIT |
| 进度条缩略图（VTT sprite） | Vidstack `thumbnails` / `videojs-vtt-thumbnails` | L3 | |
| 章节与 I-frame 预览 | Shaka `getThumbnails` | L3 | |
| WebVTT 解析与渲染 | `vtt.js`（Mozilla，Apache）或 Vidstack `media-captions`（MIT，VTT/SRT/SSA 基础） | L1 | M2 选 `media-captions` 1.0.4 只做解析（M3 起 `overlay-thumbnails` 也用它的 `parseText` 读缩略图 WebVTT）；渲染（region / line / position / 避让 / 安全区）自写（ADR-005 §4）。注意：它的 `renderVTTCueString` 把实体解码后的文本直接拼进 HTML 字符串（`&lt;img onerror&gt;` 会变成真标签），不能配合 `innerHTML` 使用；Otter 只用 `tokenizeVTTCue`，用 `textContent` 建 DOM。库自带的 `CaptionsRenderer` 也用 `innerHTML`，所以 Vidstack（依赖 `^1.0.4`）同样受影响；`<v>` 的说话人名等属性值也没有转义。**上游存在未修复的 XSS：只使用解析器（`parseText`、`tokenizeVTTCue`），禁止调用它的渲染函数（`renderVTTCueString`、`renderVTTTokensString`、`createVTTCueTemplate`、`CaptionsRenderer`）。** 披露由项目负责人走私有渠道进行，链接之后补 |
| IMSC1 / TTML | imscJS（BSD-2，npm `imsc`） | L1 | 标准参考实现。M2 用 1.1.5（传递依赖 `sax` 为 ISC），动态加载。imscJS 与 sax 是 CommonJS，sax 会 `require('stream')` / `require('string_decoder')`，webpack 5 与 esbuild 浏览器构建会直接报错，所以 `text` 构建时把两者预打包进 TTML 懒加载块，Node 内置模块换成 `tooling/shims` 里的空实现（`package.json` 的 `otter.bundle`）。2.0 RC 把 puppeteer 列为运行时依赖，暂不升级 |
| ASS 特效字幕 | `jassub` / `libass-wasm`（LGPL/MIT 包装） | L1 独立加载 | 可选插件 |
| CEA-608/708 | hls.js `cea-608-parser.ts` + `output-filter.ts` | L3 | 引擎侧解析。M2 复制到 `packages/text/src/vendor/hls.js/`（hls.js@e5ff358），只做 608。hls.js / Shaka 路径用引擎自己的 608 解码（经 `text-cues` 送到渲染器），这份拷贝给 M3 自研管线用（`loadCea608()` 按需加载），屏幕到 cue 的映射按 W3C 608-to-WebVTT 定位自写 |
| 弹幕引擎 | CommentCoreLibrary（MIT，B 站格式与高级弹幕参考实现）、DPlayer `danmaku.js`、`danmaku`（weizhenye，MIT，DOM/Canvas 双渲染） | L2 / L3 | Canvas 轨道算法拿 `danmaku`，高级弹幕脚本解析拿 CCL，WebGL 批渲染自写 |
| 蒙版弹幕 | B 站公开的 `mask-image` 做法 | L4 | 只借思路 |
| 伪全屏 / iPhone 特判 | xgplayer `cssfullscreen`、Vidstack `fullscreen` 控制器 | L3 | |
| Document PiP | Chrome 官方示例 + Vidstack 实验分支 | L3 | |
| 页面小窗 | xgplayer `pip`（页面模式）/ ArtPlayer `mini` | L3 | |
| 投屏 | `@videojs/chromecast`、Vidstack `google-cast`、Shaka `cast_proxy` | L1 / L3 | AirPlay 几十行自写 |
| MediaSession / WakeLock / 屏幕方向 | Vidstack `media-session`、`screen-orientation` 控制器 | L3 | |
| WebGL YUV shader | webcodecsfundamentals 示例 / `yuv-canvas`（MIT） | L3 | GPUSurface 起点 |
| 多宫格布局 | 自写 | 自研 | 参考 Jessibuca Pro 行为，不碰其代码 |
| React / Vue 绑定 | video.js v10 `@videojs/react` hooks 形状、`@vidstack/react` | L2 | |
| 水印 / 防录屏 | 自写 | 自研 | 几十行 |
| 广告 Overlay | `videojs-contrib-ads` 时间线模型 + Google IMA SDK（闭源免费） | L4 / L1 | |

## 5. 工程流程

- L2（整个子包）放 `vendor/<project>/`；L3（文件级）放使用它的包内 `packages/<pkg>/src/vendor/<project>/`，测试资产放 `e2e/vendor/<project>/`（ADR-003 第 7 条）。每个目录一个 `UPSTREAM.json`：`{ project, repo, commit, license, level, files: [{ upstream, local }], localChanges }`。
- `scripts/check-vendor.ts`（CI 阻断）检查：头部与 `UPSTREAM.json` 一致；目录中没有未登记的文件；只有 Apache-2.0 / MIT / BSD 允许 L2 / L3；来源已列在本文件与 `THIRD_PARTY_NOTICES.md` 中；每个 L1 运行时依赖都已列在两处。
- 每个 vendored 文件头部：`// Derived from <project>@<commit> <path>, <license>`。
- 根目录维护 `THIRD_PARTY_NOTICES.md`。
- `scripts/vendor-sync.ts`：联网对比 `UPSTREAM.json` 固定的 commit 与上游默认分支，输出漂移报告（CI 定时任务中运行，不阻断）；上游修了 MSE / iOS bug 要在一周内跟上。
- CI 门禁：`license-checker` 或自写脚本，禁止 GPL 进入依赖树，LGPL 仅允许在 `decoders/*` 与 `text-ass` 以独立产物形式出现。
- 所有 L2/L3 代码过 strict TS 与项目 ESLint 再入库。
- 顺序：先 L1 把 hls.js、Shaka、mpegts.js 接上跑通全场景，QoE 面板有数据后，再按"哪个场景体积或行为不满意"决定降到 L2/L3 替换。先有可用的全场景产品，再做替换。
