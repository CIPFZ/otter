# Otter 术语表（中英对照）

- 日期：2026-11-04
- 状态：定稿（2026-11-04 负责人）
- 用途：TSDoc、文档站、包 README 里的英文写法以这里为准；中文文档（SPEC / ADR / RESEARCH / 报告）用左列。
- 规则：
  - 一个概念一个英文词，不换着用；表里没有的词照常写，出现两种写法时补进表里。
  - **公开 API 已有标识符的概念，表跟 API 走**（标识符里的词就是正文里的词）。想改名的列在文末「改名候选」，由负责人定，不在 TSDoc 里改。
  - 带括注的词（danmaku、ABR、TTFF、PiP、QoE）在每份 README、文档站手写的每页里第一次出现时写全，之后用短形式；TSDoc 里 danmaku 在 preset 与 UI 文案的注释里第一次出现时写全。

| 中文 | English | 说明 |
|---|---|---|
| 播放器 | player | `createPlayer` / 各 preset 返回的句柄；不用 instance |
| 场景预设 | preset | `@otter-player/presets/*` 的一个 sub-path；不译作 template / profile |
| 源 | source | `load()` 的参数：一个 URL，或 `Source` 对象（renditions、tracks、DRM、fallback） |
| 清单 | manifest | HLS 的 playlist 与 DASH 的 MPD 统称；单指 HLS 时可写 playlist（multivariant playlist / media playlist） |
| 分片 | segment | 清单里的一段媒体；LL-HLS 的 part 写 part |
| 直播 / 点播 | live / VOD | 形容词用 live、VOD（`live stream`、`VOD source`）；`Source.live` 是标识符 |
| 格式 | format | 认识一种源并给出引擎的插件（`format-hls` 等）；不用 protocol 指代它 |
| 引擎 | engine | 驱动一次播放的实现：适配器（hls.js / Shaka / mpegts.js）或自有管线 |
| 后端 | backend | **路由层面的选择**：把媒体交给浏览器的方式（MSE、原生 `<video>`、WebCodecs），router 在 format 之后选它；不用 renderer。对照 sink |
| 输出端 | sink | **管线层面的终点**：引擎把数据送进去的地方（MSE 的 SourceBuffer、WebCodecs 解码器、画面层）。一个 backend 里有它的 sink；对照 backend |
| 路由 | route | 为一个源选 format + backend 的过程与结果（`explain()`）；不用 dispatch |
| 管线 | pipeline | 自有引擎的 加载 → 解复用 → 转封装 → 送入 sink 链 |
| 解复用 / 转封装 | demux / transmux | demux 拆出样本，transmux 重新封成 fMP4；不用 remux 指代后者 |
| 画面层 | surface | 承载画面的元素：`<video>` 或画布（GPU surface） |
| 播放器界面 | player UI | 叠在画面上的全部界面（控制栏、顶栏、菜单、提示）。API 标识符里叫 chrome（`ChromeState`、`createChromePlugin`），正文写 player UI，提到标识符时照写 |
| 控制栏 | controls | **只指控制栏**（底部那一排按钮与进度条）；不指整个界面 |
| 皮肤 | skin | 纯 CSS 包 `ui-skin-*`；不用 theme |
| 清晰度 | quality | 面向用户的档位；内部的一档码流叫 rendition，不用 variant / level（引擎原词只在适配器里出现） |
| 码率自适应 | ABR (adaptive bitrate) | 首次出现写全称 |
| 首帧时间 | TTFF (time to first frame) | 从 `load()` 到第一帧画出；首次出现写全称 |
| 卡顿 | rebuffer | 面向用户的「缓冲中」；解码 / 音频链路内部的断流叫 stall（视频）与 underrun（音频） |
| 致命 / 非致命 | fatal / non-fatal | 错误的 `fatal` 字段：fatal 结束这次加载（可能先恢复），non-fatal 是通知；不用 critical / warning |
| 弹幕 | danmaku (scrolling comments) | 首次出现写 danmaku (scrolling comments)，之后 danmaku；不译作 bullet comments；单条叫 comment |
| 字幕（单条） | cue | 一条字幕；字幕轨叫 text track，面向用户的叫 captions |
| 多路画面 | multiview | 一块画布上同时画多路流（`@otter-player/presentation/multiview`）；监控 preset 用它 |
| 监控墙 / 宫格 | wall / tile | 监控 preset 的那面墙与墙上的一路；不用 cell / pane |
| 竖屏信息流 | vertical feed | preset 名是 `shorts`（标识符照写）；正文写 vertical feed，不用 portrait feed |
| 低延迟直播 | low-latency live | preset 名 `lowlatency`；正文写 low-latency |
| 投屏 | cast | Chromecast / AirPlay 统称；AirPlay 单指时写 AirPlay |
| 画中画 | picture-in-picture (PiP) | 文档画中画写 Document Picture-in-Picture |
| 体验质量 | QoE (quality of experience) | `qoe` 钩子与事件 |

## 改名候选（负责人定，定之前 API 与正文都照现名）

| 现在的标识符 | 冲突 | 候选 |
|---|---|---|
| `ChromeState`、`ChromeActionMap`、`ChromeOptions`、`ChromeUiActions`、`CHROME_SLICE`、`INITIAL_CHROME_STATE`、`createChromePlugin`（ui-core） | 正文叫 player UI | `PlayerUiState`、`createPlayerUiPlugin`……（1.0 前改，或保留并在 TSDoc 里注明） |
| 各 preset 选项 `controls: boolean`（`PlayerOptions` 等） | 它开关的是整个默认界面，不只控制栏 | `ui: boolean` |
| `SinkSegment.level`（engine-pipeline/sink） | 内部码流叫 rendition，不叫 level | `rendition` |
