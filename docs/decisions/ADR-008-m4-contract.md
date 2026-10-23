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
- `format-hls` 对 WebCodecs 后端提供 demuxer（mediabunny 读 HLS，`@otter-player/demux-mediabunny`，与 format-file 共用，按需加载），只用于无 DRM 的源；全部视频变体参与 ABR（见下），音频取与首选变体配对的那一路，全程不换。surveillance-hevc（公网 HEVC + AAC 的 HLS fMP4）因此从「优雅失败」变为可播：无头 Chrome / Android 仿真上 WebCodecs 步骤 `codecUnsupported` 后由 WASM 解码（含音频），Firefox 由 MSE 播放；另加本地 HEVC HLS 场景 `surveillance-hevc-local` 进入每次提交的 CI。
- 每一步失败：session 发 `error` QoE 事件（错误本身 + 剩余步骤），`route` QoE 事件带新的决策；`router.explain()` 记录 `<step> failed <details>` 和 `<next> selected fallback after <step>`，后端还会把该步如何运行（解码器构建、SIMD、线程、Worker）作为 `route-detail` 附在步骤上。
- 人为禁用硬解（验收与宿主开关）：`createWebCodecsDecoder({ disableVideo: true })` 让 WebCodecs 步骤不接视频（`codecUnsupported`），就像机器上没有该编码的解码器。e2e（`e2e/fallback.spec.ts`，播放器外壳 `?prefer=webcodecs&hw=off&wasm=fail`）：H.264 HLS 依次经过 webcodecs 失败（codecUnsupported）→ wasm 失败（WASM 文件缺失，workerDecoderFailed）→ mse 播放，两条 `error` 事件的剩余步骤分别是 wasm、mse 与 mse，Chrome、Firefox、Android 仿真一致；`?hw=off` 的 HEVC HLS 落在 WASM（浏览器 MSE 能播 HEVC 时不经过 WebCodecs）。
- 运行时降级（后端内）：播放中（首帧之后）WebCodecs 解码器报错，或已出过帧的解码器带着待解码数据 3 秒没有输出（`decoderStalled`），后端在自身内部换成 WASM 解码器，从当前位置之前的关键帧重新解码，显示覆盖当前位置的那一帧后继续（与 seek 同一规则，帧精确），不重建 backend、不重新加载。`router.explain()` 追加「webcodecs failed `<details>` at `<t>` s (runtime)」与「wasm selected runtime fallback inside backend-webcodecs: …」，路由的 backend 标签变为 `wasm`（`route-detail` 带 `candidate` / `outcome`，`router.annotate(step, backend)`）；QoE 发一条非致命 `decoderFallback`。只做一次：WASM 再出错是致命错误，由 session 走链的下一步（MSE）。加载阶段（首帧之前）的失败仍由 session 的链处理。e2e：`?hwfail=150` / `?hwstall=150` 让硬解在第 150 个包后报错 / 停止输出，三个环境都在同一 backend 内切到 WASM 并保持帧精确。
- 解码器复用：seek 时若渲染档位和解码器插件都没变，复用原解码器（`reset()`），不新建（WASM 构建每次新建都是 Worker 里一个新的 embind 对象，频繁新建会让它出错）。
- WebCodecs 路径的 ABR：mediabunny 的 HLS 输入提供全部视频变体（`info.videoTracks`、`Demuxer.openVideo`），后端按 `pipeline` 的规则栈（`createAbrDriver`）选择；带宽样本来自 demuxer 包装的 fetch（每次媒体下载的字节数、耗时、首字节时间；按读完、读到 `Content-Length`、或被取消时上报），缓冲水位是视频包读在时钟前面的秒数（每档位一条「lane」，读前 12 s）。切换无缝：新档位从一个关键帧开始，旧 lane 读到那里为止、播完再关闭。手动切换和向下切换取已解码位置之后的第一个关键帧（读在前面的部分丢弃），自动向上切换取已读位置之后的第一个关键帧（不浪费下载）。`quality-change` 带规则给出的原因，QoE 记 `quality-switch`。e2e（`e2e/abr-webcodecs.spec.ts`，30 s、两档、每帧编号的 H.264 HLS）：手动切换在下一个关键帧生效、无 rebuffer、画面帧号正确；高档位分片被限速后自动降档。
- 读包方式：逐个 `getNextPacket`，不用 mediabunny 的 `packets()` 迭代器（它会自行预读，HLS 下一开始就把整个档位下载完，读前控制与 ABR 都失效）。

### 6. GPUSurface（SPEC §12）

- WebGL2 优先，WebGPU 可选。WebCodecs 的 `VideoFrame` 直接上传为纹理；WASM 的 I420 以三个单通道纹理上传，在 shader 中做 YUV→RGB。
- 一张画布多个视口（多宫格共享一个 WebGL 上下文），以绕开浏览器约 16 个上下文的上限；超出时报告原因，不静默丢弃。
- `setTransform`（电子放大）与 `setFilters`（亮度、对比度、饱和度、色温、锐化）在 shader 中实现；`VideoSurface` 用 CSS `transform` 和 `filter` 实现同样的参数，两种 Surface 对同一组参数的结果要一致（e2e 比较像素）。
- 滤镜统一为一个 3×4 颜色矩阵（亮度 → 对比度 → 饱和度按 Filter Effects 的矩阵，色温为 R×(1+0.2t)、B×(1−0.2t)）加一个 3×3 十字锐化核（中心 1+4a），数值只在 `filters.ts` 里定义一次。VideoSurface 只用到亮度、对比度、饱和度时走 CSS 简写函数；用到色温或锐化时按需加载 SVG 滤镜块（feConvolveMatrix → feColorMatrix，sRGB），GPUSurface 在 fragment shader 里用同样的数字；CanvasSurface 每张画布一个画面，滤镜加在 canvas 元素的 CSS `filter` 上，与 VideoSurface 同一机制（WebKit 的 `ctx.filter` 不认 `url()`）。SVG 滤镜每次参数变化换一个新 id（WebKit 按 url 缓存已解析的滤镜）。
- 入口：`@otter-player/surface` 只含 VideoSurface 与 Overlay；GPUSurface、CanvasSurface、多视口网格、渲染器与滤镜矩阵在子路径 `@otter-player/surface/gpu`，只走 `<video>` 的页面不携带它们。§19 短视频场景 25.61 → 25.63 KB（按需加载分支），首屏 25.9 KB 不变。
- 渲染 Worker（`createGPUGrid(canvas, { worker: true })`，多宫格默认开启）：画布 `transferControlToOffscreen` 交给一个模块 Worker，纹理上传和绘制在那里用同一个 WebGL2 渲染器完成；主线程保留布局（区域、fit、变换、`contentRect`）和帧节奏，只把帧（转移）和每个视口的绘制参数发过去。最多 3 次渲染在途（回执驱动，回执到达且有待画的帧时立即发下一次），新帧覆盖尚未取走的旧帧并计数（`framesReplaced`）；代价是负载高时显示延迟最多多出约 3 帧。只在主线程上 `OffscreenCanvas` 能拿到 WebGL2 时启用，否则留在主线程。被隐藏的视口（局部全屏时的其余各路）只保留最新一帧、不上传。截图由 Worker 渲染后截取区域返回。实测（无头 Chrome，SwiftShader）：16 路 720p 在主线程上画时 rAF 降到约 50 fps，移到 Worker 后主线程 600/600。
- 无 WebGL2（例如无头 Firefox）时 `createFrameSurface` 退到 CanvasSurface；上下文计数达到 `maxContexts`（默认 16）时 `createGPUGrid` 抛出 `gpuContextLimit`，提示改用共享网格。
- 播放器外壳里的电子放大与滤镜（`@otter-player/presentation/picture`，按需入口约 1.4 KB）：`picture` 状态（缩放 1–8、平移、旋转、镜像、滤镜）由 picture 插件应用到当前显示画面的 Surface（VideoSurface、WebCodecs 画布、或多宫格焦点那一路的视口）。手势来自 InputController：Ctrl / ⌘ + 滚轮（包括 Chrome 里的触控板双指捏合）在指针处缩放，放大后普通滚轮缩小、不滚动页面，未放大时普通滚轮照常滚动页面；双指捏合以中心缩放（按上一次距离的比例）；放大后拖动平移（不越过画面边缘），拖动结束的 click 不算点击。缩放保持指针下的画面点不动（按像素计算，含控件带）。放大后的画面只在控件栏之上的区域内（`SurfaceTransform.viewportBottom`），覆盖层（字幕等）对齐未放大的画面，不随之放大（`contentRect` 为适配后的矩形，GPU / Canvas 另有 `drawnRect`）。设置菜单的「画面」页：亮度、对比度、饱和度、色温、锐化各三档与「原始画面」。多宫格里滚轮与捏合作用于该格的画面（`data-otter-picture-gestures`），焦点换到另一路时恢复原始画面。e2e：`e2e/picture.spec.ts`（`<video>` 与 WebCodecs 两条路径；滚轮、捏合、拖动、菜单滤镜；从画面像素核对放大位置）与 `e2e/multiview.spec.ts`。
- 首屏体积：「画面」行与统计开关行改由设置菜单的二级按需块构建（菜单打开时就请求），它们的文字与图标不在首屏；首屏 25.9 → 25.8 KB。
- 已知限制（WebKit 色彩管理）：WebKit 对 `<video>` 和 2D canvas 做色彩管理（未打标签的 SD 视频按 SMPTE 170M 原色转到显示色域），对 WebGL 的 `texImage2D(VideoFrame)` 不做，GPUSurface 在 WebKit 上因此与 VideoSurface 有一个固定的颜色差（红色彩条 254,0,0 对 248,36,0）；Chrome、Firefox 两条路径一致。e2e 在页面里直接探测（同一帧经 2D canvas 与经 WebGL 纹理读回比较），只对探测到差异的路径（WebKit 的 GPU 盒子）先在未加滤镜的画面上拟合一个颜色映射、平均差上限放宽到 12，差值 > 40 的像素占比 < 3% 不变；其他路径和 Chrome / Firefox 不拟合、阈值不变。彻底消除需要 GPUSurface 按 `VideoFrame.colorSpace` 在 shader 里做色彩管理，放到后续 HDR / 色彩管理批次。
- 结论（2026-10-22，CI WebKit 数据加 Windows 真机）：平台对 `<video>` 做色彩管理、对画面面（WebGL 纹理上传，WebKit 之外还有 2D canvas）不做，是**WebKit 与 Windows Edge（硬件视频通路）共有**的情况，无头 Chrome、Firefox（Linux 无头与 Windows 正式版）没有。表现都是未打色彩标签的 SD 视频按 SMPTE 170M 原色转到显示色域：红色彩条 `<video>` (248, 36, 0)，画面面 (254, 0, 0)，拟合出的映射接近恒等（对角 0.88–0.91、偏移 6–7）。e2e 现在对每个画面面拟合到 `<video>` 的颜色映射，接近恒等的不拟合、阈值不变；不接近恒等的必须像色彩管理（对角在 1 ± 0.3、交叉项 < 0.3、偏移 < 40），平均差上限 12，差值 > 40 的像素占比 < 3% 不变。实测：Edge 最差平均差 10.5、离群 2.0%；WebKit（CI）离群 ≤ 0.34%、平均差 ≤ 11。产品上的修正（GPUSurface / CanvasSurface 按 `VideoFrame.colorSpace` 在 shader / 绘制前做色彩转换，使与 `<video>` 一致）仍放到 HDR / 色彩管理批次；在此之前同一路视频在多宫格（WebCodecs）和单画面 `<video>` 上看到的红色会有可见差别。
- 已修正（2026-10-23，M5 第二批，ADR-011 §3）：画面面按帧的原色在平台给 `<video>` 做色彩管理时转到 sRGB，e2e 的颜色映射拟合已删除，回到原阈值。Edge 硬件通路最差平均差 5.37（原来拟合后 10.5），离群 1.74%。
- e2e（`e2e/surfaces.spec.ts`）在 Chrome、Firefox、Android 仿真上对 7 组参数（恒等、放大+平移、旋转 90°+镜像、亮度/对比度/饱和度、色温、锐化、3 倍放大+全部滤镜）逐像素比较三种 Surface：平均差 < 6/255，差值 > 40 的像素占比 < 3%（实测最大 1.8%），两种 Surface 的 `contentRect` 完全相等；另有对照确保画面不是空白、换帧后差异明显。

### 7. 多宫格（`@otter-player/presentation/multiview`，按需入口）

- `createMultiview({ container, columns?, label?, before? })`：一张画布、一个 WebGL2 上下文（渲染在 Worker 中），每路一个视口；没有 WebGL2 时每路一个 2D canvas，在主线程绘制，最多 4 路（`CANVAS2D_MAX_TILES`；16 路 720p 时主线程只有约 10 fps），第 5 路起 `add()` 抛出 `gpuUnavailable`（非致命）。2D 兜底不放进 Worker（2026-10-21 负责人决定）。`add(label)` 返回该路的 `surface`（交给 WebCodecs 后端作 `sink`）和覆盖在视口上的按钮。默认列数为能放下所有路的最小正方形。
- 焦点：单击或 Enter 聚焦一路（`aria-pressed`，描边）。宿主只让焦点那一路出声（其他路 `set-muted`），并用 `createFocusStore(shellStore, tileStore)` 把外壳的控件接到焦点那一路：状态是外壳状态（chrome、presentation）叠上该路状态，动作先交给该路（媒体动作），未处理的交给外壳（全屏等作用于整个墙）。控件只绑定一次，焦点切换时订阅者收到通知。
- 局部全屏：双击或 Shift+Enter 让一路铺满整面墙，其余视口区域为零（不上传、不绘制），再次双击回到网格。
- 每路是一个独立的 core（media + QoE），共享整页的解码池和一个 AudioContext；超过 16 路的那一路排队，`route-detail` 写进 `router.explain()`（「decoder queued: 16 decoders busy (pool limit) …」），并发出非致命 QoE 事件 `decoderQueued`，有路退出后自动开始。
- 墙插在外壳指定元素之前（`before`，播放器外壳传顶部栏）：高于手势 / 海报层（单击、双击归墙），低于所有控件。
- 验收（`e2e/multiview.spec.ts`）：功能用例在 Chrome、Firefox、Android 仿真上运行（每个视口显示自己那一路，从画面像素读帧号；焦点、出声、控件跟随；局部全屏；第 17 路排队）；16 路基准标记 `@bench`，只在 desktop Chrome、单 worker、8 核以上机器运行（CI 的 4 核 runner 上跳过并留 notice），要求每路 10 s 内播放 > 9 s、丢帧（时钟跳过 + 画布未显示）≤ 5%、主线程无长任务且没有超过两个 vsync 的帧间隔。数据见 `docs/reports/M4.md`。

### 8. 其余

- 后台模式：页面隐藏时 GPUSurface 停止渲染（动画帧本身不再触发，GPU 网格与渲染 Worker 只在有帧时绘制）。WebCodecs 后端在隐藏时停止视频解码与绘制（已解码的帧在播放时释放，暂停时保留），音频与时钟继续（AudioWorklet 照常运行），后台用 250 ms 的定时器代替动画帧推进时间与 `ended`；回到前台时只重启视频：从时钟之前的关键帧解码，时钟之前的帧不显示、不计入丢帧，音频与时钟不动。隐藏期间的 seek 仍会完成（加载在后台标签页里也能结束）。presentation 进入 `background` 模式。e2e（`e2e/background.spec.ts`，可见性用页面内的 `visibilityState` 模拟，因为无头浏览器切换标签页不会隐藏页面）：隐藏 2 s 画面帧号不变、`currentTime` 前进，回到前台后 0.5 s 内画面与时钟一致。
- MMS `startstreaming` / `endstreaming`：hls.js、Shaka、mpegts.js 自己处理；Otter 的 MSE sink 记录 `streaming`（`whenStreaming()`），自研的 mp4-range 引擎在 `endstreaming` 后不再发 Range 请求，FLV / TS 管线暂停读取流（TCP 背压，直播回来后由 LiveController 追帧）。单测：`packages/engine-pipeline/test/mse-sink.test.ts`。
- WebCodecs 路径的 PiP：`canvas.captureStream()` 喂给一个隐藏的 `<video>`，再对它请求 PiP。实现在按需入口 `@otter-player/presentation/canvas-pip`（不进首屏）：宿主用 `bindCanvasPip(document, store, () => 显示画面的画布)` 维持一个就绪的流视频（画布显示画面时就建好，`requestPictureInPicture()` 才能在点击里同步调用），并把它通过 `PresentationOptions.pipVideo` 交给 PresentationController；控制器只多了这个选项（PiP 用哪个 video，undefined 时用 `<video>`），`leavepictureinpicture` 改在 document 上监听（事件冒泡）。播放器的暂停状态只在变化时同步到流视频，PiP 窗口里的播放 / 暂停转成 `play` / `pause` 动作。WebCodecs 后端新增 `visible` 选项：外壳传「页面可见或有 PiP 窗口」，PiP 窗口打开时页面隐藏也不进后台模式（画面仍在窗口里）；隐藏页面没有动画帧，后端与 GPUSurface 改用定时器推进与绘制，PiP 进出时重新判断。进出 PiP 不中断播放，Document PiP 不受影响。e2e：`e2e/pip-webcodecs.spec.ts`（PiP 窗口 1.5 s 内收到的帧数、窗口里的播放 / 暂停、进出时播放位置连续；Document PiP 下画布随播放器进窗口）。
- 多标签：通过 `BroadcastChannel` 协调，同一时间只有一个实例出声。实现是按需入口 `@otter-player/presentation/single-audio` 的 `createSingleAudioPlugin({ channel? })`（默认频道 `otter-audio`，同源的播放器共用）：播放器开始有声播放（未暂停、未静音、音量 > 0）时广播自己的随机实例 id 和开始时刻（`Date.now()`，跨标签页可比）；其他正在有声播放、且开始得更早的实例收到后静音自己（`set-muted`），并发出 QoE 事件 `audio-yield { to }`。同一时刻开始的两个按 id 定一个保留声音。暂停或关闭后不自动恢复别的标签（由用户在想听的那个标签取消静音，这也算一次新的有声开始）；静音或暂停中的实例不受影响。播放器外壳装了这个插件。单测 `packages/presentation/test/single-audio.test.ts`，e2e `e2e/single-audio.spec.ts`（同一浏览器上下文的两个、三个页面）。
- `format-whep`：WHEP 客户端（POST SDP offer，取 answer），`RTCPeerConnection` 的 MediaStream 交给 native 后端。实现：
  - 契约：`FormatPlugin.openStream?(ctx: StreamContext): Promise<StreamSession>`（与 WebCodecs 的 `createDemuxer` 并列）。native 后端在格式提供它时用 `srcObject` 播放这个 MediaStream，否则照旧 `src`；`StreamSession.latency`（WebRTC 接收端抖动缓冲，`jitterBufferDelay / jitterBufferEmittedCount`）作为直播延迟上报，`onError` 是开始播放后的致命错误。
  - 客户端（`format-whep` 的按需块）：recvonly 视频 + 音频，非 trickle（等 ICE 收集完成，最多 1.5 s），`POST application/sdp`（带 `source.headers`，鉴权用），201 + `Location`，销毁时 `DELETE`。识别：`type: 'application/whep'`（1），或 URL 路径里有 `whep` 段（0.9）。
  - 失败：POST 失败或非 2xx 是 `network` 致命错误（`whepRequestFailed` / `whepRejected`），按重试预算重建；ICE 在 `connectTimeoutMs`（默认 8 s）内连不上、或进入 failed，是 `iceFailed`（`network`，不可恢复），列入 `noRetry`：同一条路径重发 offer 没有用，直接进降级链。WHEP 只能喂 native，链在这里就走完了，所以 `Source` 新增 `fallback?: Source`：同一节目的另一种协议（例如同一路流的 HTTP-FLV），当前源的所有后端都失败后重新选路（`router.explain()` 里记一步 `{ candidate: 'source fallback', outcome: 'selected', reason: 'format flv' }`，接在上一个源的失败步骤之后），重试计数清零，可以再带自己的 `fallback`。开始播放后 ICE 失败同样走这条路。
  - e2e：`e2e/cn-live-whep.spec.ts` 对本地 WHEP 服务（`e2e/whep.ts`，Vite 插件，werift 应答并按实时节奏发送循环的 VP8 片段 `e2e/media/whep/clip.ivf`）：能播、画面持续更新、延迟 < 1 s；`/whep/ice-fail` 的应答只有不可达的候选，ICE 失败后切到 `/live/stream.flv` 播放，`iceFailed` 只出现一次。Firefox（自动化下）对直接从本地服务器加载的文档不启动 ICE 收集，用例在 Firefox 上把文档经 Playwright 路由交付，并关掉主机地址的 mDNS 混淆（werift 夹具解析不了 `.local`），见 RESEARCH §1；这样 Linux 无头 Firefox 与 Windows 正式版 Firefox 都实际播放 WHEP。没有可用候选的环境里播放用例仍会跳过并留 notice。

## 代价

- 不再有许可证门禁：如果将来要对外分发，需要重新做一次许可证审计（来源记录都在，可以据此恢复）。
- mediabunny 和拷贝的 WASM 解码器都需要跟进上游；它们登记在 REUSE 与 UPSTREAM.json 里，vendor-sync 会报告漂移。
