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
| LGPL | libmedia、FFmpeg 构建、libass、libde265 | 仅 L1，且以独立 WASM / 动态模块加载，源码不进核心 |
| GPLv3 | Jessibuca 开源版、EasyPlayer 部分组件 | 仅 L4，禁止看完照抄，相似结构也不行 |
| 闭源 | B 站 nano、腾讯 TCPlayer、阿里 Aliplayer、THEO、Bitmovin、JW、IVS | 只观察行为与 API 形状，不反编译 |

## 3. 引擎层来源清单

| 模块 | 来源 | 等级 | 要改什么 |
|---|---|---|---|
| HLS 完整引擎 | hls.js | L1 适配器 | 包成 `EngineAdapter`，只暴露 `MediaBackend` 事件 |
| DASH 引擎 + DRM + 离线 | Shaka Player | L1 适配器 | 同上；DRM 配置映射 Shaka `drm.servers` |
| FLV / TS 直播引擎 | mpegts.js | L1 起步，后期 L2 `demux/flv-demuxer`、`demux/ts-demuxer`、`remux/mp4-remuxer` | 自研管线时拷 demuxer 改成 `Demuxer` 接口 |
| TS → fMP4 转封装 | hls.js `src/demux/tsdemuxer.ts` + `src/remux/mp4-remuxer.ts` + `mp4-generator.ts` | L2 | 去掉事件总线耦合，改纯函数 |
| MP4 分段加载（Range + moov） | xgplayer `xgplayer-mp4` + mp4box.js | L2 / L1 | 分段策略 + box 解析拼成 `format-mp4-range` |
| 通用 demux（MP4/WebM/MKV）给 WebCodecs | mediabunny（MIT，TS，无依赖） | L1 | 直接出 `EncodedVideoChunk` |
| ABR 带宽估计 | hls.js `src/utils/ewma-bandwidth-estimator.ts` | L3 | 几十行直接拿 |
| ABR 规则 | dash.js `BolaRule`、`ThroughputRule`、`InsufficientBufferRule` | L3 | 改成规则叠加接口 |
| Codec 字符串解析与 MediaCapabilities | hls.js `src/utils/codecs.ts` + `mediacapabilities-helper.ts` | L3 | 直接拿 |
| MSE 操作队列与配额驱逐 | hls.js `buffer-operation-queue.ts` + `buffer-controller.ts` flush 逻辑 | L3 | 拆出纯操作队列 |
| MMS 适配（AirPlay 条件、start/endstreaming） | hls.js `buffer-controller.ts` | L3 | 直接拿 |
| 直播追帧 / 动态倍速 / 看门狗 | mpegts.js `mse-controller.ts` + `player/mse-player.ts` stall 检测 | L3 | 抽成 `LiveController` |
| CMCD | `@svta/common-media-library`（SVTA 官方，Apache） | L1 | 直接用 |
| Content Steering | hls.js `content-steering-controller.ts` | L3 | 后期 |
| HLS 清单解析（自研轻引擎用） | hls.js `m3u8-parser.ts` 或 `m3u8-parser`（video.js 系） | L3 | 均 Apache |
| DASH MPD 解析 | `mpd-parser`（video.js 系） | L1 | 独立 npm 包 |
| WHEP 客户端 | `@eyevinn/whep-video-component` 或 Cloudflare WHEP 示例（MIT） | L3 | 约百行 |
| WebCodecs 播放循环 | webcodecsfundamentals.org 示例（MIT）+ libmedia 架构 | L3 / L4 | 示例可拷，libmedia 只看设计 |
| HEVC WASM 软解 | libde265.js 构建产物 / ffmpeg.wasm 定制（LGPL） | L1 独立加载 | 可选 Decoder 插件，不进核心 |
| EME 流程 | Shaka `drm_engine` | L4 | 仍建议 L1 用 Shaka |
| 测试流清单 | hls.js `tests/test-streams.js`、Shaka `demo/common/assets.js`、DASH-IF 参考流 | L3 | 省下搭测试源 |

## 4. 渲染层来源清单

| 模块 | 来源 | 等级 | 说明 |
|---|---|---|---|
| State store 与 features 组合 | video.js v10 `@videojs/core`（zustand 风格 slices） | L2 或 L4 | GA 后 L2；RC 期间 L4 自写同形状（见 SPEC Q2） |
| 无样式 UI 原语 | video.js v10 原语 / Media Chrome `media-*` 元素 | L2 | Media Chrome 已稳定可直接 vendoring，其 `MediaController` 状态桥接是 Chrome 层参考实现 |
| 默认皮肤与布局 | Vidstack default layout CSS | L2 | 换 CSS 变量命名 |
| 无障碍清单与键盘模型 | Vidstack a11y 文档与 `MediaKeyboardController` | L3 | 快捷键映射表直接拿 |
| 手势识别 | xgplayer `mobile` 插件、ArtPlayer `gesture` | L3 | MIT |
| 进度条缩略图（VTT sprite） | Vidstack `thumbnails` / `videojs-vtt-thumbnails` | L3 | |
| 章节与 I-frame 预览 | Shaka `getThumbnails` | L3 | |
| WebVTT 解析与渲染 | `vtt.js`（Mozilla，Apache）或 Vidstack `media-captions`（MIT，VTT/SRT/SSA 基础） | L1 | `media-captions` 更现代 |
| IMSC1 / TTML | imscJS（BSD-2） | L1 | 标准参考实现 |
| ASS 特效字幕 | `jassub` / `libass-wasm`（LGPL/MIT 包装） | L1 独立加载 | 可选插件 |
| CEA-608/708 | hls.js `cea-608-parser.ts` + `output-filter.ts` | L3 | 引擎侧解析 |
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

- `vendor/<project>/` 按来源分目录，每目录一个 `UPSTREAM.json`：`{ repo, commit, files[], localChanges }`。
- 每个 vendored 文件头部：`// Derived from <project>@<commit> <path>, <license>`。
- 根目录维护 `THIRD_PARTY_NOTICES.md`。
- `scripts/vendor-sync.ts`：拉取上游指定 commit，输出 diff 报告，上游修 MSE / iOS bug 后一周内跟上。
- CI 门禁：`license-checker` 或自写脚本，禁止 GPL 进入依赖树，LGPL 仅允许在 `decoders/*` 与 `text-ass` 以独立产物形式出现。
- 所有 L2/L3 代码过 strict TS 与项目 ESLint 再入库。
- 顺序：先 L1 把 hls.js、Shaka、mpegts.js 接上跑通全场景，QoE 面板有数据后，再按"哪个场景体积或行为不满意"决定降到 L2/L3 替换。先有可用的全场景产品，再做替换。
