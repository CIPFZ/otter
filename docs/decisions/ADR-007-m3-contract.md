# ADR-007：M3 契约（自研管线、LiveController、mp4-range、presentation 全模式、缩略图）

- 状态：已采纳
- 日期：2026-10-19
- 关联：`SPEC.md` §7、§8、§13.1、§15、§21；`REUSE.md` §3、§5；ADR-003（引擎契约）、ADR-004（真机与体积口径）、ADR-005、ADR-006；`docs/design/UI-DESIGN.md` §6

## 背景

M3 是第一次做 L2 vendoring（REUSE §5），也是第一次用自研代码替换一个 L1 适配器（cn-live-flv 场景中的 mpegts.js）。渲染侧要把 M2 的全屏 / PiP 过渡插件换成 SPEC §15 的完整状态机，并把 M2.5 只做了外观的四个按钮（回到直播、剧场、AirPlay、Cast）真正接通。动手之前要定下：vendored 代码放在哪里、怎样进入产物；自研管线的边界和失败时的退路；presentation 的能力探测与迁移语义；缩略图的数据从哪里来。

## 决策

### 1. L2 vendoring 的形态与流程

- L2 拷贝放在仓库根目录的 `vendor/<project>/`（REUSE §5），每个目录是一个私有 workspace 包 `@otter-vendor/<project>`，不发布：
  - 有自己的 `tsconfig`（与其他包相同的 strict 配置）和 `UPSTREAM.json`；
  - 每个文件带 `// Derived from <project>@<commit> <path>, <license>` 头部；
  - 测试放在 `vendor/<project>/test/`。
- 使用方（`pipeline`）把它列为依赖，并在 `package.json` 的 `otter.bundle` 里列出，构建时预打包进自己的 dist。消费方不需要安装 `@otter-vendor/*`，也看不到这些名字。副作用门禁与体积门禁照常按 `pipeline` 的 dist 计量。
- `scripts/vendor-sync.ts` 从「是否变化」升级为真正的 diff 报告：
  - 对每个漂移的文件，输出固定 commit 与上游默认分支之间的 unified diff；
  - 写入 `vendor-sync-report.md`，并附加到 CI 定时任务的 job summary；
  - 上游的提交历史中如果出现 MSE、iOS、Safari、WebKit 等关键词，在报告里标为「一周内跟进」。
  
  M3 的流程验收：至少完成一次「上游漂移 → 报告 → 评估 → 合入或记录不合入理由」的完整循环，结果写进 `docs/reports/M3.md`。
- 本轮的 L2 来源：
  - hls.js（Apache-2.0，固定在 `e5ff358` = v1.7.3）：`src/demux/tsdemuxer.ts` 及其依赖的 audio / video 解析器、`exp-golomb`；`src/remux/mp4-remuxer.ts`、`mp4-generator.ts`、`aac-helper.ts`；
  - mpegts.js（Apache-2.0，固定版本对应 1.8.2）：`src/demux/flv-demuxer.js`、`amf-parser.js`、`sps-parser.js`、`exp-golomb.js`。这些是 JS 源码，拷贝时转成 strict TS，转换的每一处改动都写进 `localChanges`；
  - xgplayer（MIT）`xgplayer-mp4` 的分段加载策略：只拿策略，box 解析交给 mp4box.js（L1，BSD-3）。
- mpegts.js 的 `live-latency-chaser`、`live-latency-synchronizer`、`startup-stall-jumper` 按 L3 拷到 `packages/pipeline/src/vendor/mpegts.js/`（REUSE §3 已登记 LiveController 的来源）。

### 2. 自研管线（`pipeline`）

- 结构为 Loader → Demuxer → Remuxer → MseSink：
  - **Loader**：`fetch` 流式读取，支持 Range、取消和重试谓词；CMCD 用 M2 的 decorator；
  - **Demuxer**：纯函数式接口 `push(chunk: Uint8Array) → { tracks?, samples }`。TS 用 hls.js tsdemuxer，FLV 用 mpegts.js flv-demuxer；FLV 的输出会被映射到与 hls.js 相同的轨道 / 样本模型（90 kHz 时间基、AVC / HEVC NAL 单元、AAC 帧），这样只有一个 remuxer；
  - **Remuxer**：hls.js `mp4-remuxer`，输出 init 段和 moof+mdat；
  - **MseSink**：每条 SourceBuffer 一个操作队列（M1 已复制的 hls.js 队列思路），负责配额驱逐和 MMS 的 `startstreaming` / `endstreaming`。
- 对外是一个 `Engine`（ADR-003 契约），由 `format-flv` / `format-ts` 的 `engine` 选项选择：
  - `'otter'`：自研管线，满足 cn-live-flv 验收后成为默认；
  - `'mpegts'`：M1 的适配器，保留作退路。
  
  自研管线在加载阶段出现 fatal 错误时，由会话的同 backend 重建（ADR-005 §3）处理；第二次失败时，format 用 `'mpegts'` 重建一次，并在 route 里注明原因（`pipeline fallback: <details>`）。
- **fMP4**：自研管线也接受已经是 fMP4 的输入（直通，只解析 moov / moof 取轨道信息），用于 `format-mp4-range` 和以后的 CMAF。

### 3. LiveController

- 位置在 `pipeline/live`，与引擎无关：输入是缓冲区和播放头，输出是 `playbackRate`、跳帧和告警。
  - **追帧**：延迟超过 `maxLatency`（FLV 默认 3 s）时直接跳到「缓冲末尾 − 目标延迟」；
  - **动态倍速**：延迟高于目标时，倍速在 `1.0–1.1` 之间平滑调整，低于目标时回到 1.0；用户手动改过倍速后暂停自动调整；
  - **三层看门狗**：init stall（起播后不前进）、waiting（缓冲耗尽）、stalled（有缓冲但不前进）。前两层沿用 M2 会话的看门狗，直播场景由 LiveController 接管（ADR-005 §3）。
- 新的媒体 action `seek-to-live` 和 `Engine.seekToLive?()`：
  - 自研管线：跳到「缓冲末尾 − 目标延迟」；
  - hls.js：跳到 `liveSyncPosition`；
  - Shaka：跳到 `seekRange().end − 目标延迟`；
  - mpegts 适配器：跳到缓冲末尾 − 目标延迟。
  
  「回到直播」胶囊派发 `seek-to-live`。
- 验收（SPEC §21）：cn-live-flv 本地推流场景，自研管线的稳态延迟 ≤ 2 s，TTFF 不劣于 mpegts.js 适配器。用同一个本地流、同一台机器，各跑 10 次取中位数对比，写进报告。

### 4. format-mp4-range

- 流程：
  1. HEAD 请求或 Range `bytes=0-` 取文件头；
  2. moov 在文件末尾时，再发一次尾部 Range；
  3. 用 mp4box.js 解析 moov，得到样本表和关键帧；
  4. 按关键帧切出约 2 s 一段，按需发 Range 请求取 mdat 片段；
  5. 用 mp4box.js 的分段输出（或自研管线的 fMP4 直通）生成 moof+mdat，交给 MseSink。
- 多清晰度：`Source` 新增 `renditions?: { src, width, height, bitrate }[]`，多个 mp4 地址视为同一节目的不同档位，要求关键帧对齐（时间相同）。切档时：
  - 在下一个关键帧边界，追加目标档位的 init 段和对应时间之后的片段；
  - 同编码时直接追加，跨编码时先 `changeType`；
  - 不清空已缓冲的当前档位。
  
  这就是「无缝」的定义：播放不中断，`waiting` 不触发，画面在边界处切换。ABR 用 M2 的规则栈。
- 验收：mp4-range 场景手动和自动切档时都不出现 `waiting`，切换后分辨率改变，e2e 断言。

### 5. presentation 全模式状态机（替换 M2 过渡插件）

- 用 `createPresentationController(options)` 实现 SPEC §15，并以插件形式接入 store：
  - store 中保存 `presentation: { mode, capabilities, pending }`；
  - action 有 `request-presentation { mode }`、`exit-presentation`，以及兼容的 `toggle-fullscreen`、`toggle-pip`、`toggle-theater`、`toggle-mini`；
  - QoE 事件：`presentation-change`、`presentation-denied { from, to, reason }`。
- 每次迁移都是：同步调用浏览器 API → 等待结果 → 确认或回滚。等待期间 `pending` 是目标模式，store 里的 `mode` 不先改，拒绝时发出 `denied` 和原因（`notAllowed`、`unsupported`、`noUserGesture`、`busy`、`dismissed`）。
- 能力探测，每个环境按实际报告 `native` / `emulated` / `false`：
  - `fullscreen`：支持元素全屏为 `native`；iPhone 为 `emulated`（伪全屏：容器 `position: fixed`、`100dvh`、锁定 body 滚动，保住自定义 UI、字幕和弹幕）；
  - `pip`：`requestPictureInPicture`，或 Safari 的 `webkitSetPresentationMode`；
  - `docpip`：`documentPictureInPicture`；
  - `mini`：`IntersectionObserver`，为 `emulated`；
  - `theater`：纯布局，为 `emulated`，只派发事件、加 `data-otter-theater`，由宿主调整尺寸；
  - `background`：`visibilitychange`，为 `native`，只能被动进入，`request('background')` 会被拒绝（`unsupported`）。
- Document PiP 不中断播放：
  1. 迁移前记录 `currentTime`、是否暂停和倍速；
  2. 复制样式表，把整个播放器根节点移入 PiP 窗口；
  3. 移动后如有必要，恢复播放位置并重新 `play()`。
  
  e2e 断言迁移前后播放头连续前进（跳变 < 0.5 s），`paused` 保持 false。窗口关闭时把根节点放回原处的占位元素。
- 伴随行为：
  - 全屏（含伪全屏）时尝试 `screen.orientation.lock('landscape')`，失败不报错；
  - 播放中且处于全屏，或播放器可见时，申请 WakeLock；暂停或隐藏时释放；
  - MediaSession：设置元数据，处理 play / pause / seekbackward / seekforward / seekto，定期设置 `positionState`。
- 投屏：
  - **Cast**：Remote Playback API（`video.remote.watchAvailability` / `prompt()`）；
  - **AirPlay**：`webkitShowPlaybackTargetPicker` 与 `webkitplaybacktargetavailabilitychanged`。
  
  两者的可用性写进 store，按钮按可用性显示。Google Cast Web Sender SDK 是外部脚本，留给 `plugin-cast`（之后的里程碑）。e2e 在浏览器里替换对应 API（init script），断言按钮可用、点击后同步调用了 API、状态随事件更新。
- 剧场按钮派发 `toggle-theater`，「回到直播」派发 `seek-to-live`。
- iPhone：伪全屏是默认；用户选择「系统全屏」（`webkitEnterFullscreen`）时，字幕切换到原生 TextTrack（见下一条）。

### 6. 原生 TextTrack 路径（`text`）

- `createText({ native })` 接收外壳提供的 sink：`{ addTextTrack(kind, label, language): TextTrack }`，也就是 video 元素，由外壳传入，`text` 自己不碰 video。
- 字幕在以下情况镜像成原生 `VTTCue`：
  - presentation 进入只渲染 video 的模式（iPhone 系统全屏、视频 PiP），自动切换；
  - 宿主设了 `mode: 'native'`。
  
  回到其他模式时，原生轨道置为 `hidden`，恢复自定义渲染。
- 原生路径不带 CVAA 样式，交给系统字幕偏好；这一点会写进报告。

### 7. 缩略图（`overlay-thumbnails`）

- 预览卡的数据接口：`ThumbnailProvider.at(time) → Promise<Thumbnail | null>`，`Thumbnail` 是 `{ url, x, y, w, h }`（sprite）或 `{ bitmap }`（解码帧）。由外壳把它提供给 `ui-core` 的进度条（`provideThumbnails(root, provider)`，与 `provideStore` 同样的上下文机制）。
- 两种来源：
  - **VTT sprite**：`Source.thumbnails = { src: 'thumbs.vtt' }`，解析 `image.jpg#xywh=x,y,w,h`，复用 media-captions 的解析器；
  - **I-frame playlist**：HLS 清单里有 `EXT-X-I-FRAME-STREAM-INF` 时，用 hls.js 的 `createIFramePlayer()`（L1）挂到一个离屏 `<video>`，`loadMediaAt(t)` 后把帧画到 canvas，输出 `bitmap`。这条路径只在主引擎是 hls.js 时可用，通过 `MediaPlugin.thumbnails()` 暴露；节流为每 200 ms 最多一次请求。
- e2e：两种来源各一个用例，断言悬停时预览卡出现缩略图（sprite 断言 `background-position`，I-frame 断言 canvas 有非空像素）。

## 代价

- 两套 demuxer 来源（hls.js、mpegts.js）同时维护。FLV 映射到 hls.js 的样本模型多了一层转换，但只维护一个 remuxer。
- 预打包 vendored 代码让 `pipeline` 的 dist 变大，所有内容都在格式插件的按需块里，不进首屏，`check:engine-chunks` 会继续检查。
- I-frame 缩略图依赖 hls.js；非 hls.js 路径只有 sprite 缩略图。
- 伪全屏改动宿主页面的 body 样式（锁定滚动），退出时恢复，这一点写进集成文档。
