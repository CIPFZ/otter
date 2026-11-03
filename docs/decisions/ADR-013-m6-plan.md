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

### 7a. 监控墙用例拆成功能与测量（2026-11-02 负责人）

- 依据：ADR-008 §7「基准独占 runner」。CI macOS 的 main 步骤里，四路墙的丢帧率与首帧随 runner 负载摆动：负载 7–18（4 核），空闲 CPU 低到 2 %；同一棵树 c93d22f 放在 main 的位置也超 5 %（RESEARCH §1）。所以这不是产品回归，判定放错了地方。
- surveillance 四路的三条用例（HTTP-FLV、WS-FLV、直播 TS）各拆成两条：
  - **功能，留在 main**：四路都在 WebCodecs 上播（直播、无致命错误、时间在走）；点一下右上那路，焦点到它，1 s 内只有它不静音；另有一条：同一主机 7 路 HTTP-FLV，第 7 路有非致命的 `tooManyConnectionsPerHost`，7 路里 6 路在播。哪一路被浏览器压住由请求发出的先后决定，不一定是第 7 路，所以产品消息改为「其中一路会等」。
  - **测量，进 @solo**（`--workers=1`，solo 步骤自己起预览服务）：5 s 实时（> 4.5 s）、GPU 墙丢帧 ≤ 5 %、首帧（一路 FLV 中位数 ≤ MSE 参照 + 300 ms，直播 TS 每路 ≤ 1 s）。
- 16 路 @bench 不动。SPEC §19 的口径数字不动。
- 直播 TS 的 flaky 标注撤掉：原因已定，判定换到了 solo。
- 结案条件：solo 里 desktop-safari 三种传输丢帧 ≤ 5 %、TS 首帧 ≤ 1 s，连续 2 次。solo 里丢帧仍 > 5 % 就作为产品缺陷另开编号；TS 首帧仍 > 1 s 就立 F15，先看首字节到首关键帧那约 300 ms 是 mediabunny 读探测字节还是在等 PAT / PMT。

- **判定的范围（2026-11-03 负责人）**：性能口径（实时、丢帧、首帧）只判 desktop-safari 与 desktop-chrome（另加真 Edge）；emulated-iphone、emulated-android 与无头 Firefox 只测量、记录，不判定。依据：
  - 监控墙不是手机场景，真 iPhone 在 M7；
  - `f369598` 上 emulated-iphone 的直播 TS 在 solo 里红，随后在 `87499d6` 上查了三样，都排除了产品原因：
    - 两边实际选中的解码器相同（avc1.42c01e，WebCodecs，hardware），解码池加渲染 Worker 都是 5 个、核数都是 4；产品里没有按 UA 或触屏分支的代码，路由步骤里也没有平台相关的一步，只是 iPhone 仿真的 `pointer: coarse` 为 true，没有代码读它；iPhone 每路画布像素反而少（164,887 对 518,400）。
    - 在 solo 里对调运行顺序（iPhone 先跑）：两种顺序都达标，首帧 529–725 ms，丢帧 0 %。
    - 当时只播 4.01–4.25 s 的那次没有任何错误事件，但没有停顿记录可核；`87499d6` 起装了独立停顿记录，这一跑没有停顿。

### 8. 第三批第一停：React 绑定与 SSR（2026-10-30 负责人）

- 只做 React 与 SSR 安全；Vue / Svelte 等 React 验收后再开。
- `@otter-player/react`：`<OtterPlayer create …>`、`useOtterPlayer`、`useOtterState`。只依赖 store 的 `getState` / `getInitialState` / `subscribe`，不导入 Otter 运行时；preset 由宿主经 `create` 传入。播放器在 effect 里建，放进组件盒子里新建的子容器（Strict Mode 的二次挂载不会把外壳建进同一份标记）。服务端与客户端首次渲染都只输出带 `aspect-ratio` / poster 的空盒子。
- SSR 安全的检查：
  - `check-side-effects` 改为判定全部入口（含 sub-path，共 64 个）：
    - 在 Node 里逐个导入，拦截 `window`、`document`、`AudioContext` 等浏览器全局的读取，报错或读取都算失败；
    - 顶层 `class … extends <浏览器独有全局>` 也算失败，esbuild 会把它当作纯代码删掉，所以摇树判定看不见它。
    
    「摇树后为空」对全部入口都要求；sub-path 里只放行三处纯的顶层值，按入口与源文件列白名单（`check-side-effects.ts` 的 `SUBPATH_PURE_VALUES`，2026-11-02 负责人），别处新增的照样报告：
    - `pipeline/transmux`、`engine-pipeline/demux`：hls.js 的 MP4 盒子表与写盒子的类（vendored，L3，`mp4-generator.ts`、`mp4-tools.ts`），加 mpegts.js AMF 解析器的字节序探测（一个对 ArrayBuffer 的立即执行函数，`amf-parser.ts`）。改成摇树后为空要改 vendored 代码，同步上游时要合并。
    - `pipeline/captions`：CEA-608 解析器 `Object.freeze` 的默认笔样式（vendored）。
    - `presets/tv`：TV 按键表，由 input 的默认按键表去掉上下键生成（`tv.ts`，连带 `input/src/index.ts` 的 `DEFAULT_HOTKEYS`）。
    
    它们只用 ArrayBuffer、`Object.freeze` 这类服务端也有的东西，服务端导入检查照样通过。来源靠构建产物里的 `//#region` 注释定位。peerDependencies（react）的静态导入不算副作用。
  - 调用时碰浏览器的三处：
    - `defineElements()` 不传 registry 时，服务端什么也不做；
    - TTML 解析在服务端给出明确的错误，不再是 imscJS 里的 ReferenceError；
    - Shaka / mpegts.js 引擎的创建**没有加守卫**：引擎要 `<video>` 元素才建得出来，服务端走不到这里，按 `window` 守卫只是猜测。现有引擎单测本身就在没有 window 的 Node 里跑。
- 示例页：basic、vod、surveillance 各一页（`e2e/site/react-*.html`），构建时在 Node 里服务端渲染、浏览器里水合；e2e 查无水合不匹配、能播放、hook 跟随。

### 9. 第三批：Vue 与 Svelte（2026-11-02 负责人：范围与 React 一致）

- `@otter-player/vue`：`OtterPlayer`（setup 函数组件，以选项对象导出：顶层不调用 `defineComponent`，导入时什么都不执行）、`useOtterPlayer`、`useOtterState`（store、ref 或 getter；服务端读初始状态，挂载后才订阅）。
- `@otter-player/svelte`：
  - 主入口是纯 TypeScript，不导入 Svelte：`otterPlayer` action 与 `otterState` store（Svelte store 约定）。
  - 组件 `OtterPlayer.svelte` 以源码经 `svelte` 导出条件发布，由宿主的工具链编译，是 Svelte 库的通行做法。
  - store 不判断环境（那会读 `document`），服务端由 Svelte 订阅后立刻退订。
- 示例页三框架 × 三 preset，九页，都在构建时于 Node 里服务端渲染：`e2e/framework-ssr.ts` 取代 react-ssr.ts。`e2e/bindings.spec.ts` 九条判定：
  - 送出的 HTML 已带标记；
  - 水合保留了服务端的盒子元素（解析时打标记，水合后检查）；
  - 框架报告的水合错误为空；
  - 能播放，状态绑定跟随 store。
- Node 里的 SSR 用例每个框架一条，陷阱只计 Otter 代码的读取：Vue 与 Svelte 自身的 `typeof window` / `document` 检查不算。`check-side-effects` 的服务端导入检查也这样排除框架 peer 的读取。
- Svelte 的水合在 e2e 里查，不在单测里：单测环境里组件只按 DOM 编译一次。

### 10. 第四批第一项：ui-skin-tv 与遥控器输入（2026-11-03 负责人）

- `@otter-player/ui-skin-tv`（纯 CSS）：默认皮肤加 10 英尺层。
  - 字号：标题 36 px，时间 28 px；控件 72 px。
  - 安全区：栏在 title-safe 区（各边 5 %）。
  - 焦点环：4 px、带光晕、1.1 倍。
  - 不显示悬停提示。
  - 菜单、预览卡与徽标整体放大（`zoom`），因为它们在 shadow root 里用固定 px。
  
  构建时把相对 `@import` 的默认皮肤内联（`tooling/copy-css.ts`），dist 用 `<link>` 直接可用。
- `@otter-player/input/remote`（sub-path）：
  - 可配置的按键表：逻辑键 → 键名或平台 keyCode，默认含 Tizen 10009 / 10252、webOS 461、HbbTV 415 / 19 / 417 / 412。
  - 空间导航。
  - Back：先关菜单，再离开控件。
  - 画面上 OK 播放 / 暂停。
  - 长按左右加速快进：默认 10 s，按住 1.5 s 后 30 s，4 s 后 60 s，每 250 ms 至多一步。
  
  tv preset 从这里取，`remote` 选项传按键表与步长。
- 验收：
  - CI 新项目 `tv-1080`（Chromium，1920×1080，只跑 `e2e/tv.spec.ts`）；
  - 真 Edge 键盘模拟；
  - axe 在 tv 皮肤下零 serious / critical；
  - 电视行体积改量 tv preset + ui-skin-tv（≤ 90 KB 门禁），另加 ui-skin-tv CSS 预算 ≤ 10 KB。

### 11. 第四批第二项：shorts 竖屏手势（2026-11-03 负责人）

- 手势只认画面上的指针事件（触屏、笔、鼠标都一样），控件上的点击归控件。
  - **上下滑**：手指拖动时画面跟着走。松手时满足任一条件就切换：距离 ≥ 高度的 20 %；或快滑，即最后 100 ms 的速度 ≥ 0.5 px/ms 且移动 ≥ 30 px。否则回弹。在信息流两端时，画面只跟到三分之一。
  - **单击**：等 250 ms 确认不是双击后，暂停 / 播放。
  - **双击**：调用宿主的 `onLike(index, at)`，不暂停。
  - **长按 500 ms**：`hold-rate` 2 倍速，松手恢复。
  - 参数都在 `gestures` 选项里。
- **解码实例上限 1**：只有一个 `<video>`、一个引擎；切换时先拆掉前一条再加载下一条，不预加载。用例在 emulated-android 与 emulated-iphone 上断言三项：任意时刻存活的 MediaSource ≤ 1，正在播放的 video ≤ 1，`<video>` 元素只有 1 个。
- **不预加载的理由**（2026-11-03 负责人要求写明）：
  - 预加载下一条，要么在第二个 `<video>` 上开第二个引擎，要么在同一引擎里提前拉下一条的媒体。前者让两个解码实例与两个 MediaSource 同时存活，与上限 1 冲突；后者要求引擎能挂起一路、同时缓冲另一路，自研 HLS 引擎与 mp4-range 现在都没有这个接口。
  - 手机上同时开两路硬解（尤其 iPhone）会有解码器数量与内存的限制，1.0 不冒这个险。
- 代价：切换后的首帧要等加载完。`e2e/shorts.spec.ts` 记录从松手到首帧的耗时（HLS、MP4 各一条，含 180 ms 滑出动画），只记录不判定。
- **1.0 之后的路径**：
  - 只预取下一条的 init 段和第一个媒体分片（mp4-range：moov 与第一个关键帧的字节区间），作为字节缓存，不建解码器、不建 MediaSource；切换时把它们直接喂给新引擎。
  - 需要时再放宽到「同时存活的实例上限 2」（当前一条在播，下一条只到 init 与首个分片、暂停在首帧），用例的上限断言随之改为 2。
  - 需要引擎接口新增「从缓存字节起播」。
- 体积：竖屏行（shorts + 最小皮肤）31.67 / 60 KB，门禁。

## 代价

- 体积收口要动 SPF 的 L3 拷贝（候选 1）。本地改动变多，UPSTREAM.json 要记清楚，以后同步上游时要合并。
- EWMA 换掉后，hls.js 的 `ewma.ts` 从 L3 改为 L4（只借设计，REUSE 改记录）。
