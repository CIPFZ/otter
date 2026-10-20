# ADR-008：取消许可证策略；M4 契约（WebCodecs、解码池、WASM 边界、GPUSurface、多宫格）

- 日期：2026-10-20
- 状态：已采纳（§1 已生效；§2 起随 M4 实现补充细节）
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

- 数据流：demuxer 产出 `EncodedPacket`，交给 `Decoder` 实例（WebCodecs 硬解或 WASM 软解），解出的帧进入渲染缓冲，最后画到 `GPUSurface`。
- format 插件对 `webcodecs` 后端提供 demuxer，而不是 MSE 引擎：`format-file`（File / Blob）和 `format-hls`（MSE 不支持该编码时，例如 HEVC）都用 mediabunny。
- 时钟：音频解码后经 `AudioWorklet` 播放，`AudioContext.currentTime` 是主时钟；视频被动对齐，取「时间戳 ≤ 当前时间」的最新一帧，落后的帧直接丢弃并计入 `dropped-frames`。没有音轨时仍然用 AudioContext 的时钟，暂停用 `suspend()`，倍速只调整视频对齐的时钟比例（音频倍速留给后续）。
- seek：从目标时间之前的关键帧开始解码，丢掉时间戳早于目标的帧，显示第一个 ≥ 目标的帧（format-file 帧精确 seek，误差 ≤ 1 帧）。

### 3. 解码池

- 解码在 Worker 里进行，主线程只做 UI。多个实例共享一个 Worker 池，池的大小默认为 `min(硬件并发数, 4)`，同时解码的路数上限默认 16（`maxConcurrentDecoders`）。超过上限的实例排队，并报告原因。
- WebCodecs 解出的 `VideoFrame` 可转移，通过 postMessage 交给渲染端，不复制像素。WASM 解出的 I420 平面同样以可转移的 ArrayBuffer 交出。

### 4. WASM 加载边界

- `decoder-wasm-hevc` 只在硬解不可用（`VideoDecoder.isConfigSupported` 为 false，或配置、解码失败）时才加载，在自己的 Worker 中实例化。
- 检测 `crossOriginIsolated`：只有为 true 时才可能使用多线程构建。目前拷贝的 Jessibuca 构建是单线程的（`USE_PTHREADS=0`），所以总是走单线程；检测结果写进路由说明。SIMD 版本在 `WebAssembly.validate` 通过 SIMD 探测时使用，否则用非 SIMD 版本。

### 5. 三级降级

- 顺序按 router 已有的链：WebCodecs 硬解 → WASM 软解 → MSE → native。每一步的失败原因都进入 `router.explain()`，每次降级发出 QoE 事件，以便观测和导出。
- 运行时降级：WebCodecs 在播放中出错（例如解码器报错、或连续若干帧无输出），在同一 backend 内切到 WASM，并从最近的关键帧重新开始。

### 6. GPUSurface（SPEC §12）

- WebGL2 优先，WebGPU 可选。WebCodecs 的 `VideoFrame` 直接上传为纹理；WASM 的 I420 以三个单通道纹理上传，在 shader 中做 YUV→RGB。
- 一张画布多个视口（多宫格共享一个 WebGL 上下文），以绕开浏览器约 16 个上下文的上限；超出时报告原因，不静默丢弃。
- `setTransform`（电子放大）与 `setFilters`（亮度、对比度、饱和度、色温、锐化）在 shader 中实现；`VideoSurface` 用 CSS `transform` 和 `filter` 实现同样的参数，两种 Surface 对同一组参数的结果要一致（e2e 比较像素）。
- 滤镜统一为一个 3×4 颜色矩阵（亮度 → 对比度 → 饱和度按 Filter Effects 的矩阵，色温为 R×(1+0.2t)、B×(1−0.2t)）加一个 3×3 十字锐化核（中心 1+4a），数值只在 `filters.ts` 里定义一次。VideoSurface 只用到亮度、对比度、饱和度时走 CSS 简写函数；用到色温或锐化时按需加载 SVG 滤镜块（feConvolveMatrix → feColorMatrix，sRGB），GPUSurface 在 fragment shader 里用同样的数字，CanvasSurface 通过 `ctx.filter` 引用同一种 SVG 滤镜。
- 入口：`@otter-player/surface` 只含 VideoSurface 与 Overlay；GPUSurface、CanvasSurface、多视口网格、渲染器与滤镜矩阵在子路径 `@otter-player/surface/gpu`，只走 `<video>` 的页面不携带它们。§19 短视频场景 25.61 → 25.63 KB（按需加载分支），首屏 25.9 KB 不变。
- 无 WebGL2（例如无头 Firefox）时 `createFrameSurface` 退到 CanvasSurface；上下文计数达到 `maxContexts`（默认 16）时 `createGPUGrid` 抛出 `gpuContextLimit`，提示改用共享网格。
- e2e（`e2e/surfaces.spec.ts`）在 Chrome、Firefox、Android 仿真上对 7 组参数（恒等、放大+平移、旋转 90°+镜像、亮度/对比度/饱和度、色温、锐化、3 倍放大+全部滤镜）逐像素比较三种 Surface：平均差 < 6/255，差值 > 40 的像素占比 < 3%（实测最大 1.8%），两种 Surface 的 `contentRect` 完全相等；另有对照确保画面不是空白、换帧后差异明显。

### 7. 多宫格

- 多个播放器实例共享一个 GPUSurface 画布（每路一个视口）和一个解码池；同时只有焦点那一路出声；双击某一路时局部全屏（该视口铺满画布）。

### 8. 其余

- 后台模式：页面隐藏时 GPUSurface 停止渲染；MSE 后端响应 MMS 的 `endstreaming`，停止取流。
- WebCodecs 路径的 PiP：`canvas.captureStream()` 喂给一个隐藏的 `<video>`，再对它请求 PiP。
- 多标签：通过 `BroadcastChannel` 协调，同一时间只有一个实例出声。
- `format-whep`：WHEP 客户端（POST SDP offer，取 answer），`RTCPeerConnection` 的 MediaStream 交给 native 后端。

## 代价

- 不再有许可证门禁：如果将来要对外分发，需要重新做一次许可证审计（来源记录都在，可以据此恢复）。
- mediabunny 和拷贝的 WASM 解码器都需要跟进上游；它们登记在 REUSE 与 UPSTREAM.json 里，vendor-sync 会报告漂移。
