# Otter 术语表（中英对照）

- 日期：2026-11-04
- 状态：草案，待负责人看过后定稿
- 用途：TSDoc、文档站、包 README 里的英文写法以这里为准；中文文档（SPEC / ADR / RESEARCH / 报告）用左列。
- 规则：一个概念一个英文词，不换着用；表里没有的词照常写，出现两种写法时补进表里。

| 中文 | English | 说明 |
|---|---|---|
| 播放器 | player | `createPlayer` / 各 preset 返回的句柄；不用 instance |
| 场景预设 | preset | `@otter-player/presets/*` 的一个 sub-path；不译作 template / profile |
| 格式 | format | 认识一种源并给出引擎的插件（`format-hls` 等）；不用 protocol 指代它 |
| 引擎 | engine | 驱动一次播放的实现：适配器（hls.js / Shaka / mpegts.js）或自有管线 |
| 后端 | backend | 把媒体交给浏览器的方式：MSE、原生 `<video>`、WebCodecs；不用 renderer |
| 路由 | route | 为一个源选 format + backend 的过程与结果（`explain()`）；不用 dispatch |
| 管线 | pipeline | 自有引擎的 加载 → 解复用 → 转封装 → 送入 sink 链 |
| 解复用 / 转封装 | demux / transmux | demux 拆出样本，transmux 重新封成 fMP4；不用 remux 指代后者 |
| 输出端 | sink | 管线的终点（MSE 的 SourceBuffer、WebCodecs 解码器） |
| 画面层 | surface | 承载画面的元素：`<video>` 或画布（GPU surface） |
| 控件外壳 | chrome | 控制栏、菜单、提示这些叠在画面上的 UI 整体；不用 controls 指代整体 |
| 皮肤 | skin | 纯 CSS 包 `ui-skin-*`；不用 theme |
| 清晰度 | quality | 面向用户的档位；内部的一档码流叫 rendition，不用 variant / level（引擎原词只在适配器里出现） |
| 码率自适应 | ABR (adaptive bitrate) | 首次出现写全称 |
| 首帧时间 | TTFF (time to first frame) | 从 `load()` 到第一帧画出；首次出现写全称 |
| 卡顿 | rebuffer | 面向用户的「缓冲中」；解码 / 音频链路内部的断流叫 stall（视频）与 underrun（音频） |
| 弹幕 | danmaku | 不译作 bullet comments；单条叫 comment |
| 字幕（单条） | cue | 一条字幕；字幕轨叫 text track，面向用户的叫 captions |
| 监控墙 / 宫格 | wall / tile | 一面 GPU 墙；墙上的一路叫 tile，不用 cell / pane |
| 低延迟直播 | low-latency live | preset 名 `lowlatency`；正文写 low-latency |
| 投屏 | cast | Chromecast / AirPlay 统称；AirPlay 单指时写 AirPlay |
| 画中画 | picture-in-picture (PiP) | 文档画中画写 Document Picture-in-Picture |
| 体验质量 | QoE (quality of experience) | `qoe` 钩子与事件 |
