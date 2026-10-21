# ADR-008：取消许可证策略；M4 契约（WebCodecs、解码池、WASM 边界、GPUSurface、多宫格）

- 日期：2026-10-20
- 状态：已采纳（§1 已生效；§2、§6 已实现；其余随 M4 实现补充细节）
- 关联：SPEC §6.3、§9、§12、§15、§21；REUSE；AGENT §3；ADR-003、ADR-007

## 背景

M4 的 WebCodecs 路径需要一个通用 demuxer。原计划用 mediabunny（REUSE 表登记为 MIT），实际上它从 1.0 起就是 MPL-2.0，按原来的许可证策略不能进入发布的依赖树。项目负责人的决定是：Otter 是自用项目，不对外分发，不发布 npm 包，不存在任何许可证义务，许可证策略全部取消。

## 决定

### 1. 取消许可证策略

- 删除 `scripts/license-gate.ts`、`scripts/license-policy.ts`、`scripts/lib/license.ts` 及其测试，以及 `pnpm check` 和 CI 里的许可证门禁。
- `scripts/check-vendor.ts` 只检查来源记录：每个拷贝文件带 `// Derived from <project>@<commit> <path>` 头（后面可以带许可证名，仅作记录），目录下的 `UPSTREAM.json` 列出全部文件和本地改动，拷贝的项目已列在 REUSE.md。许可证白名单、THIRD_PARTY_NOTICES 条目、L1 依赖表三项检查删除。`UPSTREAM.json` 的 `license` 字段改为可选。
- `THIRD_PARTY_NOTICES.md` 保留为来源索引，不再是门禁。
- REUSE.md §2「许可证红线」整节删除；L1–L4 只表示「从哪拿、怎么拿」的工程含义。
- AGENT.md §3 的许可证规则换成一句：任何开源项目的代码都可以直接引入、拷贝、修改，只需在 vendored 文件头和 UPSTREAM.json 里记录来源，便于日后 diff 上游。
- 来源记录和 `scripts/vendor-sync.ts` 保留：它们是为了跟进上游修复，与许可证无关。

以前因许可证而绕路的决定，重新评估如下：

| 事项 | 以前 | 现在 |
|---|---|---|
| WebCodecs 的通用 demuxer | 计划 mediabunny，但许可证不合规 | 直接用 mediabunny（L1）。1.61 支持 MP4 / WebM / MKV，并且能读 HLS（`HLS_FORMATS` + `UrlSource`），本地文件和 surveillance-hevc 的 HLS fMP4 走同一条 demux 路径 |
| HEVC 软解 | 计划自己用 emscripten 从源码编译 libde265，在独立 WASM 中加载 | 直接拷 Jessibuca 4.0.0 的 `jv4-decoder` WASM 产物（ffmpeg libavcodec，H.264 + HEVC，有 SIMD 与非 SIMD 两版，embind 接口 `setCodec / decode → I420`），作为 L2 放进 `decoder-wasm-hevc`。不需要再搭 emscripten 工具链；WASM 仍然按需加载，原因是体积（约 1 MB）和放进 Worker，与许可证无关 |
| 三级降级链 | Jessibuca 只能借设计（L4） | Otter 的降级在 router 里（`webcodecs → wasm → mse → native`，M0 起就在），结构不变。Jessibuca 解码器的错误判定、等待关键帧等做法可以直接拷 |
| libmedia、EasyPlayer | 只看设计 | 可以直接拷，用到时登记来源 |
| `text-ass`（libass） | 只能 L1，独立加载 | 不再受限；按需加载仍然保留，原因是体积 |

### 2. WebCodecs 后端（`backend-webcodecs`，SPEC §6.3）

- 数据流：format 插件的 `createDemuxer()` 打开源，交出 `Demuxer`（`info` 带每条轨道可直接配置解码器的 `setup`，`packets()` / `seek()` 按解码顺序交出 `EncodedChunk`）；backend 按 `FallbackStep.decoder` 从 `BackendContext.decoders` 里选 `Decoder`（硬解步骤选 `webcodecs`，软解步骤选 `wasm*`，音频总是 `webcodecs`），解出的帧进入帧队列，交给宿主提供的 `FrameSink`（`@otter-player/surface/gpu` 的 FrameSurface 满足它；引擎层不依赖渲染层）。
- format 插件对 `webcodecs` 后端提供 demuxer，而不是 MSE 引擎：`format-file`（File / Blob，mediabunny）现在可用，`format-hls`（MSE 不支持该编码时，例如 HEVC）下一批接入。只能喂 WebCodecs 的格式，选路直接从 `webcodecs → wasm` 开始（reason `format only feeds WebCodecs`），否则默认顺序里没有它，所有源都会 `noRoute`。`format-file` 只在有 WebCodecs 时对 Blob 打分（0.9，高于 mp4-range 的 0.8），没有时打 0，Blob 仍走 `<video>`。
- 帧：`DecoderConfig.output` 交出 `DecodedFrame`（`VideoFrame` / `AudioData` / `I420Frame`），三者都可转移（`frameTransferables()`），解码挪进 Worker 池时只是 Decoder 换个地方运行，backend 不变。
- 时钟：媒体时间由 `AudioContext.currentTime` 推导（锚点 + 倍率），有没有音轨都一样；页面里所有 WebCodecs 实例共用一个 AudioContext。音频解码后进 `AudioWorklet`，worklet 自己不计时，只按收到的锚点把「此刻对应的媒体时间」的样本取出来播放，所以 seek、暂停、时钟源切换都不需要额外同步。视频被动对齐：每个渲染帧取「时间戳 ≤ 当前时间」的最新一帧，跳过的帧计入 `dropped-frames`；解码跟不上时时钟停住（`waiting`），攒够 3 帧再走。
- 共享 AudioContext 的生命周期：对正在播放（`paused` 为 false）的实例计数。暂停只冻结该实例的锚点；计数归零 5 秒后（`IDLE_SUSPEND_MS`）`suspend()`，期间有实例开始播放则取消。下一次 play 时 `resume()`（限时 1 秒），成功后各实例的时钟按 statechange 重新锚定到 AudioContext；失败或不返回时，该时钟留在 `performance.now()`，播放超过 1 秒发 `audioClockUnavailable`（与自动播放策略挂起时同一条路径）。最后一个实例销毁时 `close()`。单测：`packages/backend-webcodecs/test/clock.test.ts`。
- 倍速只改时钟倍率，倍率 ≠ 1 时音频静音（音频变速留给后续）。
- AudioContext 跑不起来时（手势之前被自动播放策略挂起；或者没有音频设备，例如 Linux 上的无头 Firefox：`resume()` 永不返回），时钟改用 `performance.now()`，AudioContext 开始运行后重新锚定；「state 是 running 但时间不走」由看门狗识别。播放超过 1 秒仍不在 AudioContext 时钟上时，发一次非致命的 `audioClockUnavailable`。worklet 模块加载与 `resume()` 都有超时；音频输出不可用时发 `audioOutputUnavailable`，画面照常播放。
- seek：从目标时间之前（含）的最后一个关键帧开始解码，丢掉被目标之后的帧覆盖的帧，显示覆盖目标时刻的那一帧，即「时间戳 ≤ 目标的最后一帧」，帧序号 `floor(t × fps + ε)`，与 `<video>` 和播放时的规则一致：t 落在一帧的后半段时显示的仍是当前帧，不是下一帧。判断时有 0.5 ms 容差：WebM 以毫秒存时间戳（第 32 帧存为 1.067，晚于 32/30），没有容差会落到前一帧。新的 seek 立即作废进行中的 seek（generation 计数，`reset()` 解码器），旧 seek 的帧不会画出来。e2e 对 30 fps、GOP 90 的样本从画面像素读出帧序号，断言等于 `floor(t × fps + ε)`；目标有帧起点、帧前半段和帧后半段（每个样本至少 3 个后半段），按 round 取帧的实现会失败。
- load 在第一帧画到 FrameSink 上之后才 resolve（`first-frame` 发出、`readyState` 4）；`buffered` 是整个文件。

### 3. 解码池（`@otter-player/decoder-pool`）

- 解码在 Worker 里进行，主线程只做 UI 和渲染。整页共用一个池（`sharedDecodePool()`），池的大小默认 `min(hardwareConcurrency, 4)`，Worker 按需创建，新解码器放到负载最少的 Worker 上。同时解码的路数上限默认 16（`maxDecoders`）；超过上限的解码器不报错，进 FIFO 队列，`queued` 回调给出原因（「16 decoders busy (pool limit); waiting, n in line」），有路关闭时按顺序开始；排队期间送来的数据包先缓存在主线程，并计入 `decodeQueueSize`，所以后端的预读上限照常起作用。
- 池与解码器插件的约定（`WorkerCodec`）：插件提供一段自包含的函数源码 `(env) => ({ create(config, out) })`，不能 import、不能引用外部变量；池把它作为脚本载入 Worker（Blob URL + `importScripts`，不用 eval），每个 Worker 每种实现只载入一次。`create` 返回 `decode / flush / reset / close`，通过 `out.frame / out.error / out.queue` 回报。WebCodecs 解码器（视频）和 WASM 解码器都按这个约定运行；WebCodecs 的音频留在主线程（开销小，输出本来就要进 AudioWorklet）。
- 帧以可转移对象交回：`VideoFrame` 直接转移，WASM 的 I420 转移其 `ArrayBuffer`，都不复制像素。`reset()` 使代数加一，之前的帧到达后直接丢弃；挂起的 `flush()` 在 reset 时结算。
- 统计：每路的帧数、Worker 编号、在 `decode()` 里花的时间（`stats()`），用于多宫格的每路 CPU 报告。

### 4. WASM 加载边界（`decoder-wasm-hevc`）

- 来源：Jessibuca 4 的 `jv4-decoder` 产物（jessibuca@e5405ba，v4 分支），`videodec.{js,wasm}`（FFmpeg 的 h264 / hevc 解码器，无 SIMD）与 `videodec_simd.{js,wasm}`（Android libhevc / libavc，SIMD），L2 原样拷贝，按 sha256 固定（`check-vendor` 校验，构建产物不能加来源头）。
- **不可重建**：仓库里有 C++ 胶水（`packages/decoder/wasm/src`）和 emcc 链接脚本（`make_videodec*.py`），但 FFmpeg（commit d7cf115，libavcodec 58.134；configure 行可从 .a 里读出）、libhevc、libavc 都只有预编译的静态库，没有构建脚本，emscripten 版本也没有记录。备选：用 emscripten 从源码编 libde265，或按同一 configure 行（`--disable-everything --enable-decoder=hevc,h264 --enable-parser=hevc,h264 --disable-asm …`）编 FFmpeg 的解码器，配本仓库自己的胶水；在需要修补解码器本身、或需要多线程构建时启用。
- 胶水的两个缺陷不改二进制，在 Otter 的 Worker 代码里绕开：`setCodec` 把 extradata 指向一个函数返回后就释放的字符串，下次 `clear()` 时 FFmpeg 会释放这个悬空指针，所以总是以 Annex B 配置（extradata 为空），参数集在关键帧前带内送入；时间戳参数是 `unsigned int`，微秒在 71 分钟后溢出，所以传帧序号，Worker 里映射回时间戳。
- 只在硬解不可用时加载：路由的 `wasm` 步骤（WebCodecs 步骤失败后，例如 `codecUnsupported`）才会创建它；它在池的 Worker 里运行，Worker 在第一个解码器时 fetch 胶水与 WASM（约 1 MB）。每个 Worker 一个模块实例（固定 128 MB 堆），每路一个 embind `VideoDecoder`。
- 资源位置：默认在本模块旁边的 `vendor/jessibuca/`（包构建按 `otter.assets` 拷到 `dist/vendor/jessibuca/`），宿主可用 `baseUrl` 指定。
- 检测：`WebAssembly.validate` 一个 SIMD 探测模块，通过则用 SIMD 版本，否则用无 SIMD 版本；`crossOriginIsolated` 检测并报告。两个拷贝的构建都是单线程（`USE_PTHREADS=0`），所以 COOP/COEP 与否都走单线程。检测结果由后端的 `route-detail` 事件写进 `router.explain()`，例如「hvc1.1.6.L93.90 on wasm-hevc (software): jv4-decoder libhevc/libavc (SIMD), single-threaded (crossOriginIsolated false; the copied builds have no threads), in the decode pool」。
- 实测（无头，720p HEVC，单路）：SIMD 版每帧约 5 ms，无 SIMD 版约 9 ms；Chrome、Firefox、Android 仿真上 seek 都逐帧准确。

### 5. 三级降级

- 顺序按 router 已有的链：WebCodecs 硬解 → WASM 软解 → MSE → native。每一步的失败原因都进入 `router.explain()`，每次降级发出 QoE 事件，以便观测和导出。
- 什么时候走这条链：只能喂 WebCodecs 的格式（format-file）；源带 HEVC 编码提示且浏览器没有 HEVC 支持；宿主 `preferBackend: 'webcodecs'`（新增：以前偏好只能在可行步骤里提前，默认顺序里没有 WebCodecs 时不起作用，现在偏好 WebCodecs 意味着整条链，reason「WebCodecs preferred by policy: full chain」）。其他情况仍是 MSE 优先。
- `format-hls` 对 WebCodecs 后端提供 demuxer（mediabunny 读 HLS，`@otter-player/demux-mediabunny`，与 format-file 共用，按需加载），只用于无 DRM 的源；取最高码率的视频变体和与之配对的音频，这条路径上还没有 ABR。surveillance-hevc（公网 HEVC + AAC 的 HLS fMP4）因此从「优雅失败」变为可播：无头 Chrome / Android 仿真上 WebCodecs 步骤 `codecUnsupported` 后由 WASM 解码（含音频），Firefox 由 MSE 播放；另加本地 HEVC HLS 场景 `surveillance-hevc-local` 进入每次提交的 CI。
- 每一步失败：session 发 `error` QoE 事件（错误本身 + 剩余步骤），`route` QoE 事件带新的决策；`router.explain()` 记录 `<step> failed <details>` 和 `<next> selected fallback after <step>`，后端还会把该步如何运行（解码器构建、SIMD、线程、Worker）作为 `route-detail` 附在步骤上。
- 人为禁用硬解（验收与宿主开关）：`createWebCodecsDecoder({ disableVideo: true })` 让 WebCodecs 步骤不接视频（`codecUnsupported`），就像机器上没有该编码的解码器。e2e（`e2e/fallback.spec.ts`，播放器外壳 `?prefer=webcodecs&hw=off&wasm=fail`）：H.264 HLS 依次经过 webcodecs 失败（codecUnsupported）→ wasm 失败（WASM 文件缺失，workerDecoderFailed）→ mse 播放，两条 `error` 事件的剩余步骤分别是 wasm、mse 与 mse，Chrome、Firefox、Android 仿真一致；`?hw=off` 的 HEVC HLS 落在 WASM（浏览器 MSE 能播 HEVC 时不经过 WebCodecs）。
- 运行时降级（未实现，后续）：WebCodecs 在播放中出错（例如解码器报错、或连续若干帧无输出），在同一 backend 内切到 WASM，并从最近的关键帧重新开始。目前播放中的解码错误是致命错误，由 session 走同一条链重建（从当前位置继续）。

### 6. GPUSurface（SPEC §12）

- WebGL2 优先，WebGPU 可选。WebCodecs 的 `VideoFrame` 直接上传为纹理；WASM 的 I420 以三个单通道纹理上传，在 shader 中做 YUV→RGB。
- 一张画布多个视口（多宫格共享一个 WebGL 上下文），以绕开浏览器约 16 个上下文的上限；超出时报告原因，不静默丢弃。
- `setTransform`（电子放大）与 `setFilters`（亮度、对比度、饱和度、色温、锐化）在 shader 中实现；`VideoSurface` 用 CSS `transform` 和 `filter` 实现同样的参数，两种 Surface 对同一组参数的结果要一致（e2e 比较像素）。
- 滤镜统一为一个 3×4 颜色矩阵（亮度 → 对比度 → 饱和度按 Filter Effects 的矩阵，色温为 R×(1+0.2t)、B×(1−0.2t)）加一个 3×3 十字锐化核（中心 1+4a），数值只在 `filters.ts` 里定义一次。VideoSurface 只用到亮度、对比度、饱和度时走 CSS 简写函数；用到色温或锐化时按需加载 SVG 滤镜块（feConvolveMatrix → feColorMatrix，sRGB），GPUSurface 在 fragment shader 里用同样的数字；CanvasSurface 每张画布一个画面，滤镜加在 canvas 元素的 CSS `filter` 上，与 VideoSurface 同一机制（WebKit 的 `ctx.filter` 不认 `url()`）。SVG 滤镜每次参数变化换一个新 id（WebKit 按 url 缓存已解析的滤镜）。
- 入口：`@otter-player/surface` 只含 VideoSurface 与 Overlay；GPUSurface、CanvasSurface、多视口网格、渲染器与滤镜矩阵在子路径 `@otter-player/surface/gpu`，只走 `<video>` 的页面不携带它们。§19 短视频场景 25.61 → 25.63 KB（按需加载分支），首屏 25.9 KB 不变。
- 渲染 Worker（`createGPUGrid(canvas, { worker: true })`，多宫格默认开启）：画布 `transferControlToOffscreen` 交给一个模块 Worker，纹理上传和绘制在那里用同一个 WebGL2 渲染器完成；主线程保留布局（区域、fit、变换、`contentRect`）和帧节奏，只把帧（转移）和每个视口的绘制参数发过去。最多 3 次渲染在途（回执驱动，回执到达且有待画的帧时立即发下一次），新帧覆盖尚未取走的旧帧并计数（`framesReplaced`）；代价是负载高时显示延迟最多多出约 3 帧。只在主线程上 `OffscreenCanvas` 能拿到 WebGL2 时启用，否则留在主线程。被隐藏的视口（局部全屏时的其余各路）只保留最新一帧、不上传。截图由 Worker 渲染后截取区域返回。实测（无头 Chrome，SwiftShader）：16 路 720p 在主线程上画时 rAF 降到约 50 fps，移到 Worker 后主线程 600/600。
- 无 WebGL2（例如无头 Firefox）时 `createFrameSurface` 退到 CanvasSurface；上下文计数达到 `maxContexts`（默认 16）时 `createGPUGrid` 抛出 `gpuContextLimit`，提示改用共享网格。
- 已知限制（WebKit 色彩管理）：WebKit 对 `<video>` 和 2D canvas 做色彩管理（未打标签的 SD 视频按 SMPTE 170M 原色转到显示色域），对 WebGL 的 `texImage2D(VideoFrame)` 不做，GPUSurface 在 WebKit 上因此与 VideoSurface 有一个固定的颜色差（红色彩条 254,0,0 对 248,36,0）；Chrome、Firefox 两条路径一致。e2e 在页面里直接探测（同一帧经 2D canvas 与经 WebGL 纹理读回比较），只对探测到差异的路径（WebKit 的 GPU 盒子）先在未加滤镜的画面上拟合一个颜色映射、平均差上限放宽到 12，差值 > 40 的像素占比 < 3% 不变；其他路径和 Chrome / Firefox 不拟合、阈值不变。彻底消除需要 GPUSurface 按 `VideoFrame.colorSpace` 在 shader 里做色彩管理，放到后续 HDR / 色彩管理批次。
- e2e（`e2e/surfaces.spec.ts`）在 Chrome、Firefox、Android 仿真上对 7 组参数（恒等、放大+平移、旋转 90°+镜像、亮度/对比度/饱和度、色温、锐化、3 倍放大+全部滤镜）逐像素比较三种 Surface：平均差 < 6/255，差值 > 40 的像素占比 < 3%（实测最大 1.8%），两种 Surface 的 `contentRect` 完全相等；另有对照确保画面不是空白、换帧后差异明显。

### 7. 多宫格（`@otter-player/presentation/multiview`，按需入口）

- `createMultiview({ container, columns?, label?, before? })`：一张画布、一个 WebGL2 上下文（渲染在 Worker 中），每路一个视口；没有 WebGL2 时每路一个 2D canvas，在主线程绘制，最多 4 路（`CANVAS2D_MAX_TILES`；16 路 720p 时主线程只有约 10 fps），第 5 路起 `add()` 抛出 `gpuUnavailable`（非致命）。2D 兜底不放进 Worker（2026-10-21 负责人决定）。`add(label)` 返回该路的 `surface`（交给 WebCodecs 后端作 `sink`）和覆盖在视口上的按钮。默认列数为能放下所有路的最小正方形。
- 焦点：单击或 Enter 聚焦一路（`aria-pressed`，描边）。宿主只让焦点那一路出声（其他路 `set-muted`），并用 `createFocusStore(shellStore, tileStore)` 把外壳的控件接到焦点那一路：状态是外壳状态（chrome、presentation）叠上该路状态，动作先交给该路（媒体动作），未处理的交给外壳（全屏等作用于整个墙）。控件只绑定一次，焦点切换时订阅者收到通知。
- 局部全屏：双击或 Shift+Enter 让一路铺满整面墙，其余视口区域为零（不上传、不绘制），再次双击回到网格。
- 每路是一个独立的 core（media + QoE），共享整页的解码池和一个 AudioContext；超过 16 路的那一路排队，`route-detail` 写进 `router.explain()`（「decoder queued: 16 decoders busy (pool limit) …」），并发出非致命 QoE 事件 `decoderQueued`，有路退出后自动开始。
- 墙插在外壳指定元素之前（`before`，播放器外壳传顶部栏）：高于手势 / 海报层（单击、双击归墙），低于所有控件。
- 验收（`e2e/multiview.spec.ts`）：功能用例在 Chrome、Firefox、Android 仿真上运行（每个视口显示自己那一路，从画面像素读帧号；焦点、出声、控件跟随；局部全屏；第 17 路排队）；16 路基准标记 `@bench`，只在 desktop Chrome、单 worker、8 核以上机器运行（CI 的 4 核 runner 上跳过并留 notice），要求每路 10 s 内播放 > 9 s、丢帧（时钟跳过 + 画布未显示）≤ 5%、主线程无长任务且没有超过两个 vsync 的帧间隔。数据见 `docs/reports/M4.md`。

### 8. 其余

- 后台模式：页面隐藏时 GPUSurface 停止渲染；MSE 后端响应 MMS 的 `endstreaming`，停止取流。
- WebCodecs 路径的 PiP：`canvas.captureStream()` 喂给一个隐藏的 `<video>`，再对它请求 PiP。
- 多标签：通过 `BroadcastChannel` 协调，同一时间只有一个实例出声。
- `format-whep`：WHEP 客户端（POST SDP offer，取 answer），`RTCPeerConnection` 的 MediaStream 交给 native 后端。

## 代价

- 不再有许可证门禁：如果将来要对外分发，需要重新做一次许可证审计（来源记录都在，可以据此恢复）。
- mediabunny 和拷贝的 WASM 解码器都需要跟进上游；它们登记在 REUSE 与 UPSTREAM.json 里，vendor-sync 会报告漂移。
