# ADR-012：弹幕引擎与水印（M5 第四批）

- 状态：已实现（2026-10-26，第四批三项）；2026-10-27 验收，按负责人答复补 §8（验收口径与体积）、§9（已知限制）
- 日期：2026-10-26
- 关联：`SPEC.md` §1.1、§13.2、§13.3、§19；ADR-011（M5 批次）；`REUSE.md` §4

## 背景

M5 第四批：新包 `@otter-player/danmaku`（按需加载，首屏不变）与水印。范围按 SPEC §13.2：滚动 / 顶部 / 底部 / 逆向、seek 后重建、暂停与倍速同步、密度 / 透明度 / 字号 / 显示区域、屏蔽词与正则、防遮挡蒙版。不做高级弹幕（定位 / 旋转 / 路径、代码弹幕）、CSS 轨道渲染、服务端蒙版、实时 WebSocket 弹幕、广告 Overlay。

## 决定

### 1. 时间轴是媒体时间

- 一条弹幕的位置只由「当前媒体时间 − 它的时间」决定：滚动弹幕 `x = 舞台宽 − (舞台宽 + 弹幕宽) × Δt / 滚动时长`，逆向对称，顶部 / 底部居中停留 4 s。
- 所以暂停时画面不动（不重画），倍速自然按倍速走，seek 后按新时间重建舞台（此刻仍在飞行中的弹幕从半路进入，更早的不出现），后台页面不画（`visibilityState` 为 hidden 时跳过；回到前台直接画当前时间的样子，没有积压）。
- 上游 `danmaku`（weizhenye）把运行中的弹幕按进场后的墙钟时间乘倍速移动，暂停 / 倍速 / 后台都要额外记账；这里改成纯函数（本地改动记在 `vendor/danmaku/UPSTREAM.json`）。
- 媒体时间来自叠加层的共享 rAF（与字幕同一个 tick，SPEC §3 第 4 条）。有些引擎的 `currentTime` 按视频帧更新：两次报告之间按倍速外推，最多领先 0.25 s，播放中不倒退；检测到跳变（向后 > 0.3 s，或向前超过经过时间 + 1.5 s）即视为 seek 并重建。

### 2. 轨道与解析的来源

- **轨道分配**：`danmaku`（weizhenye，MIT，v2.0.10）的 `allocate`，L3。改动：显示区域放不下时丢弃该条（B 站「防重叠」），上游会取模后重叠。
- **解析**：CommentCoreLibrary（MIT）的 B 站 XML 解析，L3。改动：不用 DOM（上游默认 `innerHTML` 进一个 div，自己注释说不可信），用正则切分 `<d p="...">` 并解码 XML 实体，Worker 与无 document 环境可用；只收 1–6 模式，高级（7）、代码（8）、BAS（9）计入 `skipped`。
- **JSON**：CCL 通用格式（`stime` 毫秒）、B 站 DanmakuElem 的 JSON 形式（`progress` 毫秒、`fontsize`、`content`，可带 `data` / `elems` 包装）、DPlayer 的 `[时间, 类型, 颜色, 作者, 文本]`，自写。
- 解析器是按需块（`parse`，约 1.2 KB），`load-danmaku` 时才加载。

### 3. 设置与偏好

- 状态：`danmaku`（开关、不透明度 0.1–1、字号 0.5–2、速度 0.5–2、显示区域 1/4–全部、密度 0–1、屏蔽滚动 / 顶部 / 底部、屏蔽词）与 `danmakuStatus`（加载状态、条数、跳过数、当前渲染器与原因）。
- 动作：`set-danmaku`（任意子集，越界值钳到范围内）、`load-danmaku`（`url` / `text` / `comments`）、`send-danmaku`（当前媒体时间插入，带边框标记为自己的）、`clear-danmaku`；换片源时自动清空。
- 密度按弹幕序号确定性抽样（每次重建保留同一批）；屏蔽词是子串，`/pattern/flags` 是正则（无效正则按原文匹配）；自己发的弹幕不受密度和屏蔽词影响。
- 设置页在设置菜单的二级按需块里（「弹幕」行与页面，中英文案），首屏字节不变；`@otter-player/preferences` 把 `danmaku` 设置整体存下，下次访问启动时恢复（须在 danmaku 插件之后安装）。

### 4. 渲染

- **Canvas 2D**（主块）：每条弹幕的文字只画一次到自己的小画布（粗体、描边，深色字用浅色描边，自己的加边框），每帧整舞台清空后逐条 `drawImage`，坐标取整到设备像素。舞台盖在画面矩形上（`contentRect`），不透明度用元素的 CSS opacity。
- 字号随画面高度缩放（高度 / 540，限制在 0.6–1.5 倍），滚动时长 8 s / 速度。
- **WebGL 批渲染**（按需块 `webgl`，约 1.8 KB）：弹幕文字仍用 2D 画布光栅化，然后打进一张纹理图集（最大 4096²，按高度分档的行；一行里的弹幕都离场后整行复用），每帧一次缓冲上传、一次 draw call。图集放不下时该条不画（计入可解释的丢弃，实测 5000 条/分钟时远未用满）。
- **OffscreenCanvas Worker**（按需块 `worker-renderer` + Worker 脚本，合计约 2.8 KB）：舞台画布 `transferControlToOffscreen` 交给 Worker，WebGL 图集与文字光栅化都在 Worker 里做；主线程只保留时间轴与轨道（每帧 O(在屏条数)），每帧把进场 / 离场的弹幕和在屏弹幕的位置发过去。Worker 还在画上一帧时，主线程这一帧不发（取最新位置）。
- 三种渲染器的弹幕位置都由主线程按媒体时间算出，e2e 对三种分别核对位置、暂停、倍速、seek。

### 5. 渲染器选择（`renderer: 'auto'`，默认）

- **起点**：Canvas 2D（`canvas2d selected: default: Canvas 2D (auto)`）。
- **观察窗口**：最近 60 个实际绘制的帧，每帧记录在屏条数、主线程本帧耗时（定位 + 绘制）、与上一个 rAF 的间隔。切换后 5 s 内不再切换。
- **升到 WebGL**（当前为 Canvas 2D 时，先于 Worker 判断）：窗口平均在屏 ≥ 120 条，或主线程本帧耗时 p90 ≥ 4 ms。理由：120 条约是 1080p 全屏铺满的量；4 ms 是 16.7 ms 帧预算的四分之一，给页面其他工作留出余量。
- **换到 Worker**：rAF 间隔 p90 ≥ 25 ms（掉到 40 fps 以下），而本引擎自己的耗时 p90 < 4 ms（慢的不是我们），并且在屏 ≥ 40 条。
- **WebGL 不比阈值便宜**（当前为 WebGL，且主线程本帧耗时 p90 仍 ≥ 4 ms）：有 Worker 就换到 Worker（绘制离开主线程），否则回到 Canvas 2D；WebGL 记 `rejected: slower here`，本页不再尝试，避免来回切换。依据：CI 的 macOS WebKit 上 WebGL 主线程每帧 p50 6 ms / p95 19 ms，Canvas 2D 只有 1 ms。
- **回到 Canvas 2D**：最近 600 帧（约 10 s）平均在屏 ≤ 40 条，且 rAF 间隔 p90 < 25 ms。
- **不可用**：WebGL2 上下文拿不到、Worker 里没有 WebGL2、没有 OffscreenCanvas 时记 `rejected`，本页不再尝试，留在当前渲染器。
- **解释输出**：每次选择都记一条 `{candidate, outcome, reason}`（与 `router.explain()` 的步骤同形），在 `danmakuStatus.steps`（最近 20 条），当前渲染器与理由在 `danmakuStatus.renderer / reason`。例如：`canvas2d selected: default: Canvas 2D (auto) | webgl selected: dense: 144 comments on stage (≥ 120) | worker selected: main thread busy: frame interval p90 50.0 ms (≥ 25), own cost p90 0.7 ms`。
- 宿主可固定渲染器（`renderer: 'canvas2d' | 'webgl' | 'worker'`），不可用时退回 Canvas 2D 并记 `rejected`。
- 阈值在 `src/policy.ts` 的 `POLICY` 里，单测覆盖每一条。

### 6. 蒙版（防遮挡）

- **输入两种**，都是逐帧的、按需块 `mask`：
  - **SVG 帧**：`[{time, svg}]` 的 JSON，每帧一个带 `viewBox` 的 `<svg>`，主体是 `<path d>`。不用 DOM：正则取 `viewBox` 与各 `d`，直接 `new Path2D(d)` 画进 320 宽的小画布（按需，换帧才重画）。按 `time` 二分查找，留 1 ms 余量（时间常被取整到毫秒）。
  - **WebM alpha**（VP8 / VP9 `alpha_mode=1`）：一个隐藏的 1 px `<video>`（放进文档，否则有的引擎不呈现帧），提前 2 s 逐帧 seek 到帧中点 `(n + 0.5) / fps`，画进 320 宽小画布缓存（保留身后 0.5 s）。seek 落在哪一帧以 `requestVideoFrameCallback` 的 `mediaTime` 为准：Chromium 报该帧起点（取整到毫秒，取最近帧），Firefox 报所 seek 的时间（帧中点，取 floor）；落到别的帧时那一帧记为不可达，宁可不画蒙版也不用邻帧。第一帧没有透明像素即报 `rejected`（该浏览器不解码 alpha）。需要全 I 帧或短 GOP 的文件。
- **取哪一帧**：按**画面上正在显示的那一帧**的媒体时间（`@otter-player/surface` 的 `trackFrameTime(video)`：rVFC 的 `mediaTime` 加上自 `expectedDisplayTime` 以来的播放时间，不超过 `currentTime`：WebKit 的 `expectedDisplayTime` 早于上屏，外推会超前，RESEARCH §1），经 `Overlay.tick(now, mediaTime, frameTime)` 传入；没有 rVFC 时用媒体时间。播放中再提前「一个显示帧 + 渲染器延迟」×倍速：本帧画的弹幕要到下一次合成才上屏，Worker 还要加上一次往返（按最近的发送时间队列量出）。
- **擦除**：Canvas 2D 用 `destination-out` 把蒙版画在整块舞台上；WebGL 片元着色器 `o *= 1 − mask.a`（`u_size` 用 highp，移动端 mediump 不够）；Worker 收到蒙版的 ImageBitmap 副本，版本不变不重发。蒙版覆盖画面矩形（`contentRect`），与舞台同位。
- **动作与状态**：`load-danmaku-mask {kind: 'svg' | 'webm', url | frames, fps}`、`clear-danmaku-mask`；`danmakuStatus.mask` 为 `svg: N frames` / `webm: 30 fps` / `rejected: 原因`；换片源时清掉。
- **对齐验收**：`e2e/danmaku-mask.spec.ts`（`@solo`，单独一步、一个 worker 跑：并行套件共享软件合成器时帧会迟到，测的就不是我们了）。编号阶梯片（顶部 10 位帧号）上叠一条每帧右移 1/30 画面宽的带状蒙版（第 k 带 = 帧号 mod 30），底部铺满绿色弹幕；每张截图里读帧号与绿色缺口所在的带：暂停时必须完全一致，播放中 ≤ 1 帧。SVG × 三种渲染器、WebM × 解码 VP9 alpha 的浏览器。

### 7. 水印

- `@otter-player/overlay-watermark` 的 `createWatermark({mode, ...})`，两种模式，都是叠加层（z 400，在字幕与弹幕之上），挂在播放器容器里：
  - **static**：角标（文字或图片 URL，默认右上，不透明度 0.6），DOM 元素按画面矩形定位，字号随画面高度缩放。
  - **moving**：防录屏的文字（如用户 ID），画在 canvas 上，每 `interval` 秒（默认 8）换到画面内的随机位置（留 2 % 边距，不出画面），不透明度 0.25。MutationObserver 守着：被移除、`display:none`、`visibility`、改 `opacity`、`hidden` 都立即还原。
- **跟随**：挂在容器里，所以原生 / 伪全屏与 Document PiP（容器整体搬进 PiP 窗口）自然跟随。视频 PiP 窗口里只有一个 `<video>`：`createPipComposite(doc, picture, watermark)` 把画面与水印按画面原尺寸画进一个 canvas（PiP 打开时每个显示帧画，平时每秒两次保持流就绪），交给 `@otter-player/presentation/canvas-pip` 的 `bindCanvasPip`，PiP 打开的就是这条合成流。合成画布创建时先画一帧：没有帧的流视频会一直拖住页面的 load 事件（Chromium），也拿不到元数据进 PiP。
- 旧的 `createWatermarkOverlay(options)` 保留，等于 static 模式的 `overlay`。
- e2e `e2e/watermark.spec.ts`：角标位置与像素、移动水印换位且不出画面并在移除 / 隐藏后还原、全屏里在全屏元素内并可见、视频 PiP 的合成流帧里有水印像素、Document PiP 窗口里有水印。

### 8. 验收口径与体积（2026-10-27，负责人）

- **60 fps 统一用相对口径**（2026-10-28 负责人，测试收口轮 F3；原来本机用的绝对 20 ms 口径废除）：
  - 同一页面先量 6 s 不加弹幕的基线，再量 20 s 加弹幕的数据。
  - 达标条件：主线程弹幕耗时 p95 < 4 ms，且 rAF p95 不比基线差 30% 以上。Worker 自己上屏，页面的 rAF 看不出它掉帧，所以 Worker 自己的帧间隔同样不得比基线差 30% 以上。
  - 无长任务；不支持 longtask 的浏览器（Firefox）上，> 50 ms 的间隔 ≤ 1 次。
  - 本机 `OTTER_BENCH=1` 时断言；CI 只出通知。真机 Safari / iPhone 留 M7。
- **转交 Worker 的画布会拖慢整页的帧节奏**（真 Edge 实测）：页面上有 `transferControlToOffscreen` 的画布时，还没有弹幕，整页 rAF 基线就是 18–26 ms，普通页面是 17 ms。所以在真 GPU 上，自动策略优先主线程 WebGL，只有主线程繁忙（帧间隔 p90 ≥ 25 ms、本引擎耗时 < 4 ms）时才选 Worker（§5，现有规则就是如此，单测覆盖）。
- **Firefox 上 Worker 渲染器不可用**（F4，真实 Firefox 159 上 Worker 路径让页面卡住）：自动策略不选；宿主手动指定也拒绝，原因「Firefox: an OffscreenCanvas Worker stalls the page」写进 `danmakuStatus.steps`。根因排查单独一停。
- **蒙版对齐 ±1 帧**按截图判（截图与真实上屏的关系各引擎不同）。录屏或高速相机核对留 M7 待办。
- **体积**两档，进门禁（`.size-limit.js`，SPEC §1.1）：
  - 基本：主块 + 解析块 ≤ 10 KB。
  - 全部块：再加 WebGL、Worker（块 + 脚本）、蒙版 ≤ 15 KB。
  - 三个按需块另外各列一行。
- 2026-10-30（负责人，F4 修复）：Firefox 上 Worker 卡页的根因是 Worker 里的 `getImageData()`（同一 Worker 正往交来的画布画 WebGL；Linux 与 Windows 正式版 Firefox 都复现，删减表见 RESEARCH §1）。`gl-stage` 的精灵改为画在各自的 OffscreenCanvas 上直接上传，不再回读，所有浏览器同一条路径；Firefox 上 Worker 渲染器的拦截删除。自动策略不变（F3）：真 GPU 上优先主线程 WebGL，主线程繁忙才选 Worker。

### 9. 已知限制（接受）

- WebKit 不解码 VP9 alpha：WebM 蒙版在 Safari 上报 `rejected`，用 SVG 蒙版。Safari 的透明视频是 HEVC with alpha（MOV），不做。
- 移动水印的还原只防页面脚本与扩展的 DOM 改动，挡不住对整页做处理的截屏 / 录屏工具。
- 无头 Firefox 没有 WebGL，WebGL / Worker 两条路径的 Firefox 数字等真实 Firefox（Windows 实例）。

## 代价

- 显示区域满时直接丢弃弹幕，高密度片段会少显示一些（与 B 站「防重叠」一致）。
- 按媒体时间定位意味着暂停时弹幕也停（与 B 站一致）；直播中的实时弹幕不在本批。
- 蒙版要求全 I 帧或短 GOP 的 WebM（逐帧 seek），长 GOP 文件解码跟不上时那几帧不画蒙版；SVG 帧 JSON 体积随帧数线性增长。
- 移动水印的还原只防页面脚本与扩展的 DOM 改动，挡不住截屏工具对整页的处理；视频 PiP 加水印要多一路 canvas 合成（PiP 打开期间每帧一次 drawImage）。
