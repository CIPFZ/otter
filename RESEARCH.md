# Otter RESEARCH：Web 播放器生态全景调研

- 日期：2026-10-15
- 目的：为自研通用 Web 播放器 Otter 的选型与架构提供事实依据
- 关联：`SPEC.md`（架构）、`REUSE.md`（复用来源与等级）、`docs/decisions/`

## 1. 浏览器底层能力（所有播放器的底牌）

所有 Web 播放器都是在以下路径上做组合。选型前先看清这张表。

| 路径 | 能做什么 | 代价 / 限制 | 可用范围 |
|---|---|---|---|
| 原生 `<video src>` | MP4/WebM 渐进式；Safari 原生 HLS（含 LL-HLS、FairPlay、AirPlay） | 无 ABR 控制、无自定义请求头、缓冲不透明 | 全部浏览器；HLS 仅 Safari |
| MSE (MediaSource) | JS 自己拉分片喂 SourceBuffer，实现 ABR / 自定义缓冲 / 多轨 | 需 JS 解封装或转封装；配额限制；codec 字符串必须精确匹配 | Chrome/Edge/Firefox/macOS 与 iPadOS Safari |
| ManagedMediaSource (MMS) | iPhone 上的 MSE 替代，系统控制取流节奏与缓冲驱逐 | iPhone 上必须提供 AirPlay 备用源或显式 `disableRemotePlayback`，否则静默不启动；不提供 LL-HLS 的 JS 实现 | Safari 17.0+（iPhone 17.1+） |
| EME | DRM：Widevine (Chrome/Firefox/Edge)、PlayReady (Edge/Windows)、FairPlay (Safari)、ClearKey (调试) | 页面只搬运不透明消息，拿不到密钥；自编译 Chromium 无 CDM | 全部主流浏览器 |
| WebCodecs + WebGL/WebGPU + WebAudio | 绕过 `<video>`，自己解码、渲染、A/V 同步 | 要自己写时钟、丢帧、同步、字幕、PiP、全屏、无障碍 | Chrome 94+/Edge/Safari 16.4+（部分）/Firefox 130+ |
| WASM 软解 (FFmpeg/libde265/OpenH264) | 浏览器不支持的编码兜底（HEVC 在旧 Firefox、VVC、专有格式） | CPU 高，1080p 以上吃力；多线程依赖 SharedArrayBuffer，需 COOP/COEP；iOS 受限 | 全部，但性能差异大 |
| WebRTC (WHEP) / WebTransport | 亚秒级延迟 | 需要信令、ICE、专用服务器；HEVC 仅 Chrome 136+ 实验性 | 全部主流浏览器 / Chromium 系 |

关键结论：除只服务 Safari 的场景外，任何认真的 Web 播放器都是双路径架构，非 Apple 走 MSE，Apple 走原生 HLS 或 MMS，运行时判断。

MSE 工程要点（生产事故高频区）：
- `sb.updating === true` 时 append 抛 `InvalidStateError`，必须排队。
- `QuotaExceededError` 要 `remove(0, currentTime - 5)`，等 `updateend` 后重试。
- `addSourceBuffer` 必须在 `sourceopen` 之后。
- 跨 codec 切换不调 `changeType()` 会静默解码失败；hls.js 1.5 明确不自动跨编码族切档。
- 不要在每个错误上 `endOfStream('decode')`，会永久卡在 ended。
- Safari 的 SourceBuffer 不接受 TS，必须转封装成 fMP4。
- Chrome 108+ 支持 MSE-in-Worker（`MediaSourceHandle`），Firefox/Safari 尚无。

M1 实测发现的坑（2026-10，Otter 真实浏览器矩阵与 Windows Edge 真机）：
- hls.js 1.7 在 ManagedMediaSource 下 attach 时会清掉 `<video>` 的全部 `<source>` 并强制 `disableRemotePlayback = true`；AirPlay 备用源必须在 attach 之后再补（Otter 在 backend-mse 里统一处理，见 ADR-003 §5）。
- hls.js 把 `manifestIncompatibleCodecsError`（例如没有 HEVC 解码能力）归为 `mediaError`；如果对它调用 `recoverMediaError()`，加载永远不会结束。媒体恢复只适用于清单加载之后、而且可恢复的错误。
- hls.js `nextLevel` 要等下一个分片加载才生效，缓冲已满时手动切档不会发生；需要立即切换用 `currentLevel`（会清空缓冲）。`LEVEL_SWITCHED` 只在正在播放的分片换档时触发，LL-HLS 的 part 不一定触发；初始档位要从 `levels` 里读。hls.js 对点播也会返回一个 `latency` 值，只有 `latestLevelDetails.live` 为真时才有意义。
- Shaka 5 移除了 `streaming.autoLowLatencyMode`（传入只会报 "unrecognized key"），`lowLatencyMode` 默认为 true，且只在清单声明低延迟时生效。直播延迟用 `getLiveLatency()`（墙钟，毫秒）；`stats.liveLatency` 在没有 producer reference time 时为 NaN。
- 直播在 `loadedmetadata` 时把播放头跳到直播位置，这时还没有首帧；"播放在前进"必须从首帧开始计时。
- 拿 Chrome / Edge 调 `play()` 后紧接着 teardown 或 `pause()`，会以 `AbortError` reject；这不是错误，不能覆盖真正的 fatal 错误。
- ffmpeg 7 的 fragmented CENC（`encryption_scheme=cenc-aes-ctr`）输出的 `senc` 不合法（自己也解不了："Incorrect number of samples in encryption info"）；加密测试样本用 Shaka Packager 生成。
- Chrome 默认不开放 `HTMLMediaElement.videoTracks`；native 路径上拿不到档位是常态，不是缺陷。
- Web Component 的 shadow 样式写了 `:host { display: ... }` 就会覆盖 UA 对 `[hidden]` 的规则，必须同时写 `:host([hidden]) { display: none }`。
- Playwright WebKit（macOS 15 CI，desktop-safari 项目）MSE 起播卡死：MPEG-TS 里音频 PTS 比首个视频帧早 21 ms（AAC 编码器 priming，`start_pts` 音频 1.400、视频 1.421）时，`currentTime` 停在 0.021（首个视频帧）再也不动，`readyState=4`、已解码数帧、`buffered` 覆盖整段。hls.js 的转封装把两条轨道对齐到同一时刻所以不触发；mpegts.js 直传 TS 时 8 次里约 2–5 次触发，对齐时间戳（裸 H.264 + AAC 重新复用，`start_time` 都是 1.400）后 0/8。Chrome / Firefox 不受影响。（2026-10-19，分支 `feat/ci-webkit-diag2` 实验）因此 `media` 的卡顿恢复对"起播后播放头从未移动"用更短的阈值（`startupStallMs`，1.5 s）先 nudge 一次，再按常规 8 s 卡顿处理；测试样本保持不变，作为回归用例。

M3 presentation 实测（2026-10，Playwright Chromium / Firefox，ADR-007 §5）：
- Playwright 在 Chromium 里的 `page.evaluate` 自带用户激活（CDP `userGesture: true`），在 evaluate 里直接调用全屏、PiP 都会成功；要测"无手势被拒"，必须在页面里先等待瞬时激活过期（Chromium 和 Firefox 都是 5 s），再从定时器里发起请求。
- 无头 Firefox 的元素全屏铺满的是屏幕尺寸（1366×768），不是 viewport；断言全屏尺寸要和全屏后的 `innerWidth` / `innerHeight` 比较。
- Playwright 的 Firefox 构建提供 `documentPictureInPicture` 和 `requestPictureInPicture`，无头模式下两者都能真正进入；能力只能靠特性探测，不能按浏览器写死。
- Document PiP 把整个播放器根节点（含已升级的自定义元素、shadow DOM、`<video>`）移进 PiP 窗口：Chrome 和 Firefox 实测播放不中断，`paused` 保持 false，播放头没有超过 0.5 s 的跳变；保险起见，移动前仍记录 `currentTime`、是否暂停和倍速，移动后按需恢复。
- Safari 16.4 起有无前缀的元素全屏，13.1 / iOS 14 起有标准 `requestPictureInPicture`；Otter 只用无前缀 API，更旧的引擎走伪全屏、不提供 PiP。iPhone 的 `webkitEnterFullscreen`（系统播放器）是唯一保留的前缀 API。
- 无头 WebKit（macOS CI）有 `requestPictureInPicture`，但即使在真实点击里也会拒绝打开画中画窗口。能力仍然如实报告为 `native`，拒绝时回滚并发出带原因的 `denied`；e2e 把它记为 CI notice。
- 在 WebKit 下 MSE 暂停时不发 `progress` 事件：靠 `progress` 刷新直播延迟，「回到直播」就永远不出现。backend-mse 改为暂停期间每秒采样一次。
- hls.js 1.7 的 I-frame 播放器（`createIFramePlayer`）有两个首次加载的竞态：I-frame 清单比 MediaSource 先就绪时，一个分片都不会请求，所以要等 `MEDIA_ATTACHED` 之后再 `loadMediaAt`；分片缓冲进来之后，挂起的 seek 也可能被丢掉，所以要盯住 `buffered`，必要时自己 seek。
- hls.js 1.7 的 TS demuxer 用 `new Uint8Array(data.buffer, len, data.buffer.byteLength - len)` 保存剩余字节，没有考虑传入视图的 `byteOffset`。如果输入是大缓冲区上的一个视图，剩余部分就成了整个底层缓冲区，导致分片和字幕重复。vendored 副本改成了 `data.subarray(len)`，可以考虑提交到上游。
- mp4box.js 2.4：所有轨道的 `setSegmentOptions` 必须用同一个 `nbSamples`，否则该轨道会被静默跳过（音频不出 SourceBuffer）；`appendBuffer(…, true)` 会把剩余样本全部切成单帧分段；`rapAlignement` 判断的是分段最后一个样本，所以视频分段以下一个关键帧结尾。
- ffmpeg 7：HLS fMP4 muxer 在帧间隔很大时（每 2 s 一个 I 帧）第二个分片的 `tfdt` 写错；原始 H.264 用 `-c copy` 封装时 `-framerate` 不起作用，要用输入侧的 `-r`，否则时间戳会在第 50 帧附近挤在一起。
- 无头 Firefox（Playwright 构建，Linux）拿不到 WebGL2 上下文，`getContext('webgl2')` 返回 null；WebCodecs 路径要有 Canvas 2D 兜底（`ctx.filter` 接受 `url(#svg-filter)`，Chrome 和 Firefox 都支持）。无头 Chrome 有 WebGL2 和 WebCodecs，但 `VideoDecoder.isConfigSupported` 对 HEVC 返回 false，`crossOriginIsolated` 为 false。
- SVG `<filter>` 要写 `color-interpolation-filters="sRGB"`，否则默认在 linearRGB 里计算，和 CSS 的 `brightness()` / `contrast()` / `saturate()` 以及 shader 的结果对不上。
- 页面没有 `<meta name="viewport" content="width=device-width">` 时，移动端仿真（Pixel 7，DPR 2.625）按 980 px 布局再整体缩小，`<video>`、Canvas 和 WebGL 的缩放滤波不同，像素比较会出现系统性差异。另外截图宽度是取整后的设备像素（1081 = round(412 × 2.625)），用 `截图宽度 / clientWidth` 推算比例会偏差约 1 px，应直接用 `devicePixelRatio`。
- WebCodecs `reset()` 之后解码器回到 `unconfigured`，必须再 `configure()` 才能继续 `decode()`；seek 时用 reset 丢弃排队的工作，之后从关键帧开始送。Chrome 的 `VideoDecoder.isConfigSupported({ hardwareAcceleration: 'prefer-hardware' })` 在没有硬件解码器时返回 false（当作要求而不是偏好），可以借此区分硬解和软解。
- WebM（Matroska）的时间戳精度通常是 1 ms：30 fps 的第 32 帧存为 1.067 s，比 32/30 = 1.0667 s 晚，按「时间戳 ≤ t」找帧时要留约 0.5 ms 容差，否则 seek 到帧的起点会落到前一帧。
- Linux 上的无头 Firefox（Playwright 构建）可以创建 AudioContext 并加载 AudioWorklet 模块，但 `resume()` 永远不 settle，即使在真实点击里调用，state 一直是 suspended；无头 Chrome 不需要手势就是 running，currentTime 正常前进。依赖 AudioContext 计时的代码必须给 `resume()` 加超时并有备用时钟。
- WebKit（CI macOS）对 `<video>` 和 2D canvas 的 `drawImage` 做色彩管理：未打色彩标签的 SD H.264 按 SMPTE 170M 原色转换到显示色域，红色彩条显示为 (248, 36, 0)；WebGL 的 `texImage2D(VideoFrame)` 不做这一步，得到 (254, 0, 0)，与 Chrome 在所有路径上的结果相同。GPUSurface 与 VideoSurface 在 WebKit 上因此有一个固定的颜色映射差。e2e 在页面里探测（同一帧经 2D canvas 与经 WebGL 纹理读回比较），只对探测到差异的路径拟合映射并放宽平均差；彻底消除要在 shader 里按 `VideoFrame.colorSpace` 做色彩管理（ADR-008 §6 已知限制，放到 HDR / 色彩管理批次）。
- Windows 真机 Edge 153（RTX 3080，有界面，硬件视频通路）上 `<video>` 同样做色彩管理：同一个未打标签的 SD H.264，`<video>` 显示红色彩条 (248, 36, 0)，而 2D canvas 与 WebGL 画同一 VideoFrame 都是 (254, 0, 0)（与 WebKit 不同：WebKit 的 2D canvas 也做转换）。无头 Chrome（Linux）和 Windows 正式版 Firefox 158 三条路径一致。所以「GPUSurface / CanvasSurface 与 VideoSurface 有固定色差」不是 WebKit 独有，桌面 Chromium 走硬件视频通路时也会出现；按「2D canvas 与 WebGL 是否不同」探测平台色彩管理在 Edge 上探测不到。surfaces e2e 改为对每个画面面直接拟合到 `<video>` 的颜色映射（接近恒等就不拟合）。
- Chromium（Edge 153，Windows，RTX 3080）给 `<video>` 做色彩管理的条件是 **GPU 合成**，不是硬件解码：`--disable-accelerated-video-decode`、关掉 DirectComposition 视频叠加层后 `<video>` 照样转换；`--disable-gpu`（SwiftShader，与无头 Chrome 相同）后不转换，三条路径都是 (253, 0, 2)。转换的算法是：按 sRGB 曲线线性化，乘 SMPTE 170M → BT.709 原色矩阵（由色度坐标与 D65 算出），再按 sRGB 曲线编码；六根彩条逐一复现到个位（红 253,0,1 → 246,36,0，绿 9,255,4 → 65,251,0）。WebGL 的 `WEBGL_debug_renderer_info` 渲染器名里有 SwiftShader / llvmpipe 时就是软件合成。（2026-10-23）
- 未打色彩标签的 SD H.264，各浏览器给出的 `VideoFrame.colorSpace` 不一样：Chrome 的 `new VideoFrame(video)` 报 `smpte170m`（解码器按 REC601 推定），格式 I420（无头）/ NV12（Edge 硬件）；同一码流经 WebCodecs `VideoDecoder` 解出的帧却全是 null（I420）。Firefox 的 `new VideoFrame(video)` 是 BGRA、全为 null；`VideoDecoder` 输出 BGRX、标为 `bt709`（SD 也一样），Firefox 的 `<video>` 对未打标签的 SD 也用 BT.709 矩阵（红色彩条 255,25,2）。画面面因此按「有标签用标签；YUV 帧没有标签按高度推定（< 720 行 SMPTE 170M，否则 BT.709）；RGB 帧没有标签视为已在显示色域」取原色。（2026-10-23）
- WebKit 按 `url(#id)` 缓存已解析的 SVG 滤镜：只替换 `<filter>` 的内容、id 不变时，元素继续用旧滤镜（变换等其他属性变化触发重绘时才更新）。每次滤镜参数变化都要换一个新 id。
- WebKit 的 `CanvasRenderingContext2D.filter` 接受滤镜函数（`brightness()` 等），但 `url(#svg-filter)` 不生效。单画面的 CanvasSurface 因此把滤镜加在 canvas 元素的 CSS `filter` 上（与 VideoSurface 相同），黑边留透明。
- 无头 Chrome 的 WebGL 是 SwiftShader（CPU 模拟的 GPU，`ANGLE (… SwiftShader driver)`）：16 路 720p 的纹理上传与绘制在主线程的 WebGL 画布上时，主线程 JS 每帧只用约 3 ms，但 rAF 被画布的 GPU 工作拖到约 50 fps；把画布交给 Worker（OffscreenCanvas）后主线程恢复 60 fps。渲染 Worker 必须限制在途渲染数（回执），否则帧消息会无限堆积；回执后要立即发下一次而不是等下一个 rAF，否则渲染频率减半。
- 无头 Firefox 没有 WebGL2，多宫格退到每路一个 2D canvas，16 路 720p 时主线程只有约 10 fps：这个兜底只适合少量路数。真实 Firefox 有 WebGL2，走 GPU 路径。
- Vite 库模式下 `new Worker(new URL('./w.ts', import.meta.url))` 会把 Worker 单独打包，但默认生成以站点根为基准的绝对路径（`/assets/…`），库被别人引用时会 404；库构建要设 `base: './'`，路径才相对于模块。
- Playwright 的 `page.waitForFunction` 传入 async 函数时，返回的 Promise 本身被当作真值，条件不会真正等待；需要等异步条件时用 `expect.poll`。
- mediabunny 1.61 的 `EncodedPacketSink.packets()` 迭代器会按消费速度自行预读：对 HLS 源，本地网络下一两秒内就把整个档位的分片下载完，调用方的读前控制、限速测试和 ABR 都失去作用。需要按需下载时逐个 `getNextPacket()`。它的 `UrlSource` 按 `Content-Length` 读到长度就停止读取响应体（既不读到流结束也不取消），用包装的 `fetch` 测下载量时要在读到声明长度时上报。
- Jessibuca jv4-decoder（WASM）在同一 Worker 里频繁新建 / 删除 embind `VideoDecoder`（每次 seek 新建一个）会在十几路并发时出错（`decode()` 抛异常）；seek 时 `clear()` + `setCodec()` 复用同一个对象则稳定。
- Playwright 的 `page.evaluate` 返回 Error 对象时只保留 `message` / `stack`，自定义属性（如 `OtterError.details`）会丢失；要在页面内先映射成普通对象再返回。
- 鼠标拖动结束时浏览器仍会在同一元素上派发 `click`：拖动平移画面后要吞掉这个 click，否则会切换播放。happy-dom 构造 `WheelEvent` 时丢掉 `ctrlKey` 等修饰键（浏览器保留），单测要另行设置。
- 自己调度分片的引擎切换清晰度时，切换点（新档位的起始关键帧）至少要在播放位置前 1 秒：新档位的第一个分片要先下载、再从关键帧解码，切换点离播放头太近（实测 0.3 s）时旧档位先放完，Firefox 上偶发 rebuffer。Otter 的 WebCodecs 后端取「已解码位置之后、且不早于时钟 + 1 s 的第一个关键帧」（`SWITCH_LEAD_S`）；M5 的自研 CMAF-HLS 引擎按 MSE 切档时同样适用。
- 画布画面的视频 PiP：`requestPictureInPicture()` 只接受 `<video>`，且必须在用户手势里同步调用、视频已有元数据，否则拒绝（`InvalidStateError`）。所以 `canvas.captureStream()` 喂的隐藏 `<video>` 要在画布显示画面时就建好并播放，不能等点击时再建；隐藏方式不能用 `display:none`（部分引擎拒绝为未显示的视频开 PiP），用 1 px、透明度 0。PiP 窗口里的播放 / 暂停只作用于这个流视频，要转回播放器；播放器把自己的暂停状态同步过去时只能在状态变化时同步：store 每次 tick 都通知，若每次都同步，用户在窗口里按暂停后、`pause` 事件到达前的一次 tick 会把视频重新播放，按键被吞掉。页面隐藏时没有 `requestAnimationFrame`，画布仍在 PiP 窗口里显示，绘制要改用定时器。
- 打开 Document PiP 窗口后，Chrome 的 Android 仿真会把原页面的定时器节流到约 0.4 s 一次（焦点在 PiP 窗口）：在原页面里每 50 ms 采样播放位置时，相邻样本的间隔会变成 0.4 s 左右，判断「播放位置不跳变」要和墙钟间隔比，不能和固定采样间隔比。
- 自动化下的 Firefox（Linux 上 Playwright 的 Firefox 构建、Windows 上正式版 Firefox 158 经 WebDriver BiDi，都一样）对**直接从本地开发服务器加载的文档**不启动 ICE 收集：`setLocalDescription` 之后 `iceGatheringState` 一直是 `new`，没有任何 `icecandidate` 事件，控制台报「ICE failed, add a STUN server」。同一浏览器里 `data:`、`about:blank`，以及经 Playwright 路由（`route.fulfill`，哪怕 URL 仍是 `http://localhost:4173/...`）交付的文档都在 20 ms 内收集完成；改代理（`network.proxy.type = 0`）、关 mDNS 混淆、关本地网络访问限制都不影响。根因没有查清（2026-10-22）。e2e 的绕法：WHEP 用例在 Firefox 上把文档请求经 `route.fetch()` + `fulfill()` 转一手。另外 Firefox 的主机候选默认是 mDNS 名（`<uuid>.local`），本地 werift 夹具解析不了、ICE 失败，Firefox 项目因此设 `media.peerconnection.ice.obfuscate_host_addresses = false`；真实的 WHEP 服务端（SRS、MediaMTX 等）靠对端反射候选处理 mDNS，不需要这个设置。ICE 失败时 Firefox 的 `connectionState` 已是 `failed`，但只监听 `connectionstatechange` 的等待没有结束（到超时才报错），同时监听 `iceconnectionstatechange` 后立即结束；WebRTC 客户端两个事件都要听，并且只报一次。
- CI 的 macOS WebKit（Playwright 1.64，desktop-safari、emulated-iphone）：页面没有用户激活，`page.evaluate` 也不给（与 Chromium 相反），直到真正的点击。依赖手势的路径在 WebKit 上走的是「无手势」分支（M6，2026-10-29）。
- Playwright 1.64 经 WebDriver BiDi 驱动正式版 Firefox（`channel: 'moz-firefox'`）时：`dblclick()` 发出两次 `detail` 为 1 的 click，没有 `dblclick` 事件；`emulateMedia({ reducedMotion })` 不生效（`matchMedia` 仍为 false）。依赖这两点的用例在 `real-windows-firefox` 上跳过；真实用户的双击不受影响。
- 已知偶发（未定位，2026-10-22 记为 flaky）：CI 的 macOS WebKit（desktop-safari、emulated-iphone）上，`e2e/fallback.spec.ts` 的运行时降级用例（`?hwfail=150`，WebCodecs 解码器在第 150 个包后报错）偶尔 30 s 内没有切到 WASM，`state().backend` 一直是 `webcodecs`，重试通过；8f1a60b、0f8dbce 两次 CI 各出现一次。Chrome、Firefox、Android 仿真上没有出现，本机没有 WebKit 无法复现。猜测与 CI 的 macOS 虚拟机上 WebKit 解码偏慢、150 个包没在 30 s 内送进解码器有关，未验证。cc100ae 上首跑和重试都失败，CI 变红，所以该用例在 WebKit 上改为 `test.fixme`（跳过，`hwstall` 用例照常在 WebKit 上跑）；Chrome、Firefox、Android 仿真、真机 Edge / Firefox 上照常运行。
- 一个 `srcObject` 为 `canvas.captureStream()` 的 `<video>` 在页面加载期间放进文档、而画布一直没画过任何东西时，Chromium 的 load 事件一直不触发（视频在等第一帧，延迟了文档的 load），`page.goto` 超时；Firefox 不受影响。建流的画布要先画一帧（哪怕一块黑）。
- `requestVideoFrameCallback` 的 `mediaTime` 各引擎含义不同：seek 到帧中点 `(n + 0.5) / fps` 后，Chromium 报该帧的起点（容器时间戳，WebM 取整到毫秒），Firefox 报所 seek 的时间本身。用它确认「解出的是哪一帧」时，小数部分≈0.5 按 floor、否则按最近帧取整。不在文档里的 `<video>` 在 Chromium 上不呈现帧，rVFC 不回调，`seeked` 也可能早于新帧可画。
- WebKit（MSE 播放器，`MediaPlayerPrivateMediaSourceAVFObjC`）的 `requestVideoFrameCallback`：`mediaTime` 是渲染器当前帧的时间戳，`expectedDisplayTime` 却是「有新帧可用」回调的时间（早于真正上屏）。按 `mediaTime + (now − expectedDisplayTime)` 外推会比画面超前约 1–1.5 帧（CI macOS 实测，Chrome 同法约 −0.3 帧）。外推结果不能超过元素的 `currentTime`。
- WebKit（CI macOS，桌面与 iPhone 仿真都出现过）暂停时 seek 到 GOP 中间，有时画面一直停在该 GOP 的关键帧上，再等 10 s 也不更新（readyState 4，currentTime 已是目标值）。再发一次同样的 seek 后，画面才更新到目标帧。依赖画面帧号的用例要么 seek 到关键帧，要么在读到关键帧时重发 seek。
- CI 的 iPhone 仿真（WebKit）上，`e2e/picture.spec.ts` 偶发读不到帧号块：取到的行里一个亮像素都没有，15 s 里重发 seek 也没变，重试则通过。桌面 WebKit 上同类的「暂停 seek 后画面停在关键帧」重发 seek 就能解决，这个不行，原因未明。处理：标 flaky，靠重试；M7 在真 iPhone 上再定（2026-10-27 负责人）。
- 无头 Chrome（SwiftShader）的主线程 WebGL：往一张上一帧还在采样的大纹理（4096² 图集）里 `texSubImage2D`，约 150 个精灵在屏、每帧约 1.4 次上传时，每隔几帧就有一帧赶不上（rAF p95 33 ms）。主线程本帧只用 0.7 ms，时间不在 JS 里。去掉上传或只画一个精灵就恢复 16.7 ms。分页图集（2048 × 512）和 `desynchronized` 上下文都没有稳定改善（8 次里 2 次 16.8 ms）。同一套 GL 代码放进 Worker 后，Worker 自己的帧间隔 p95 约 18 ms，主线程 rAF 16.7 ms。
- OffscreenCanvas 在 Worker 里自己上屏：页面的 rAF 间隔看不出 Worker 掉帧（Worker 忙时会跳帧，主线程照常 60 fps）。Worker 渲染的流畅度要用 Worker 自己的帧间隔来量。
- Windows Server 2022（Datacenter 20348）默认没有 HEVC 扩展：Edge 153 的 `VideoDecoder.isConfigSupported(hvc1, prefer-hardware)` 与 no-preference 都是 false，MSE `isTypeSupported(hvc1)` 与 `decodingInfo` 也是 false，即使显卡（RTX 3080）能解。同一台机器上 H.264、AV1 的 WebCodecs 硬解都是 true。
- 同一台机器上的 Firefox 159：MSE `isTypeSupported(hvc1)` 与 `decodingInfo`（media-source）都说 HEVC 支持，而且流畅、省电；WebCodecs `isConfigSupported(hvc1)` 却是 false。MSE 那一侧的说法要以真正出画面为准（编码族剔除就是为此）。另外 Firefox 的 WebGL 渲染器名是泛化过的（实际是 RTX 3080，报「GTX 980 or similar」），不能用来判断真实 GPU。
- 有界面的 Edge（Playwright 有界面）：没有用户手势时新建的 AudioContext 保持 suspended，按自动播放策略不启动；无头 Chrome 放宽了这条，所以 CI 看不到。依赖 AudioContext 起播的路径在真机上要有手势，或者有不靠 AudioContext 的退路。
- 真 Edge（这台 Server 2022，USB 声卡 + VB-Cable）：AudioContext 空闲挂起 6 s 后经 `resume()` 恢复，8 次里有 1 次在恢复后约 1.1 s 内 `currentTime` 只前进 0.06 s（state 已是 running），像是输出设备重新打开的延迟。
- 同一台实例（`inst-01m4skyh…`，默认输出端点是一个虚拟的「Audio Device」，VB-Cable 驱动坏着）：**不含 Otter 的裸 AudioContext + 振荡器**，30 s 里每 20 ms 读一次 `currentTime`，Edge 和 Firefox 各 3 次里各有 1 次出现一段约 2.03 s 的停顿（state 一直是 running，出现时刻随机：27.3 s、20.8 s）。多宫格上的 `audioClockUnavailable`（M6 F9 复测）每一次都对上这样一段约 2.05 s 的停顿。真 Firefox 上用 AudioWorklet 录 WHEP 音轨时，`process()` 30 s 里只跑了约 1000 次（约 2.7 s 的量）就不再跑，原因未查。都要在普通声卡的机器上复核（M7，2026-10-28）。
- 这台 Windows Server 关了系统动画，所以 `prefers-reduced-motion: reduce`。Edge 经 CDP 的模拟能改回 no-preference；Firefox 经 WebDriver BiDi 改不了（已知限制），页面看到的就是 reduce。
- Playwright 1.64 经 WebDriver BiDi 驱动正式版 Firefox，又发现两处限制（之前已知 dblclick、reducedMotion 两处；处理：real-windows-firefox 上 tv 用例改按 Space、Hero 的减少动态效果那步 skip、全屏截图改截全屏元素）：`page.keyboard.press('MediaPlayPause')` 报 Unknown key；进入全屏后 `page.screenshot()` 只截原来视口大小（1280×720）的左上一块，而全屏页面是 1920×1080。
- 真实 Firefox 159（RTX 3080，有 WebGL2，Worker 里也有）：弹幕把舞台画布 `transferControlToOffscreen` 交给 Worker、用 WebGL 画时，5000 条/分钟下页面的 rAF 掉到约 10 s 一次（三次都这样），`page.evaluate` 也可能超时；同一页面用 Canvas 2D 或主线程 WebGL 都正常。无头 Firefox 没有 WebGL，所以以前测不到（M6 测试收口轮，待定位）。Linux 上的正式版 Firefox 159（Xvfb、软件 GL，没有 GPU 也没有 Windows 驱动）同样复现：Worker 那组页面 rAF p95 9999.9 ms，Canvas 2D、主线程 WebGL 都是 17.1 ms，所以不是 Windows 驱动的问题。只把画布交给 Worker 画 WebGL（清屏，或 150 个四边形 + 每帧两次 `texSubImage2D` 文字上传）、下面放一个播放中的 `<video>`，这样的最小页面在两台机器上都不复现：触发条件还在弹幕 Worker 的其他部分里（2026-10-28）。
- Playwright 1.64 的 trace（`trace: 'on'` / `'retain-on-failure'`，DOM 快照）让页面从第一份文档起就 `hasBeenActive`，Chromium 和 Firefox 都一样；`exposeBinding`、console 消息、init script 都不会。
- Playwright 1.64 经 WebDriver BiDi 驱动正式版 Firefox（`channel: 'moz-firefox'`，Windows 与 Linux 的 159 都一样）时，页面在自己的脚本运行之前就已 `hasBeenActive`：不开 trace、没有 init script 和 binding 的 `data:` 页也是。所以「无手势」的行为在 BiDi Firefox 上测不了，`e2e/no-gesture.spec.ts` 在那里 skip（2026-10-28）。
- Playwright（Chromium 系，含有界面的 Edge）的 `page.evaluate` 带用户手势执行：页面在第一次 evaluate 之前 `navigator.userActivation.hasBeenActive` 是 false，之后就是 true，自动播放策略也随之放行 AudioContext。所以「没有手势」的路径在 e2e 里只在加载完成前没有任何 evaluate 时才走得到；轮询状态的 evaluate 和页面加载赛跑时，有的实例看到有手势、有的没有（M6 测试收口轮 F1 复核，2026-10-28）。
- 有 Worker 画布（OffscreenCanvas）的页面，真 Edge 上整页的 rAF 基线就变差：同一页面还没有弹幕时 p95 18–26 ms，普通页面是 17 ms。
- 真 GPU（RTX 3080）上的主线程 WebGL 弹幕，5000 条/分钟时 rAF p95 18 ms，与基线持平：无头 Chrome 上的 33 ms 是 SwiftShader 所致。
- 真 Windows Firefox 159 上 WebM 蒙版 × Canvas 2D 的偶发 −2 帧（M6 F11）：13 次里 2 次各有一张截图差 −2 帧（15%，蒙版落后），之后同机 20 次、Linux 正式版 Firefox 20 次都没有；其余截图 0 或 −1（约四成 −1），WebGL 偶见 +1。按负责人的口径（< 20%）记 flaky，不改产品（2026-10-28）。
- `appearance: none` 的 `<input type=range>`，轨道比圆点高时（命中区 24 px、圆点 13 px）：Chromium 和 WebKit 把 `::-webkit-slider-thumb` 放在轨道顶部，要 `margin-top: (轨道高 − 圆点高) / 2` 才居中；Firefox 的 `::-moz-range-thumb` 自动垂直居中，所以只在 Firefox 上看不出来。三家的圆点中心横向都只走 [圆点宽/2, 宽 − 圆点宽/2]，按整宽百分比画的填充条在两端差半个圆点；`step` 不是 `any` 时圆点还会吸附到步长上，与连续的填充条错开（M6，负责人实看发现，2026-10-29）。
- CI 的 macOS WebKit（desktop-safari、emulated-iphone）：经 AudioWorklet 录 WHEP 收到的音轨，2 次里有 1 次两个项目都录到 463.6 Hz 的单音、接缝间隔 3.83 s，而源是 440 Hz、4.02 s；463.6 / 440 = 4.02 / 3.83 ≈ 1.054，像是录音路径的采样率错配（每个采样多出约 5% 的内容），不是页面播放出来的声音。用例在 WebKit 上标 flaky，判定不放宽（2026-10-29 负责人）。
- 测试实例 `inst-01m4skyh…` 的默认音频输出是「扬声器 (Audio Device)」= `USB\VID_46F4&PID_0002`，即 QEMU 的虚拟 USB 声卡，也是唯一 active 的输出端点；坏掉的 VB-Cable 端点根本不在列表里。上文约 2 s 的 AudioContext 停顿多半出在这块虚拟声卡上（2026-10-29，只读查询）。
- 逐帧对齐（蒙版与画面 ≤ 1 帧）在无头浏览器里与并行的其他用例共享软件合成器时测不准：帧会迟到一两帧，误差来自机器而非代码。这类用例单独一步、一个 worker 跑（`@solo`）。

## 2. 格式 / 协议 / 编码全景

### 2.1 传输与封装

| 格式 | 清单 | 分片容器 | 典型延迟 | 浏览器支持 | 适用 | 备注 |
|---|---|---|---|---|---|---|
| HLS | `.m3u8` | TS 或 fMP4 (CMAF) | 10–30s | Safari 原生，其他靠 hls.js 等 | 点播/直播通用，覆盖面最大 | TS 分片要在 JS 转封装为 fMP4，每片多 3–8ms 主线程 |
| LL-HLS | `.m3u8` + PART/PRELOAD-HINT | fMP4 | 2–4s | Safari 原生；hls.js/Shaka 实现 | 低延迟直播 | CDN 必须支持 blocking reload；iPhone 上 JS 库做不了，只能原生 |
| MPEG-DASH | `.mpd` (XML) | fMP4/WebM | 10–20s | 全靠 MSE，iPhone 仅 17.1+ | 开放标准、多编码、多 Period、DRM 灵活 | YouTube / B 站主力；Safari 弱 |
| LL-DASH | `.mpd` + chunked CMAF | fMP4 | 2–3s | 同上 | 低延迟直播 | 需 chunked transfer 透传 |
| CMAF | 一次封装双清单 | fMP4 (cbcs 加密) | 取决于清单 | 全部 | Netflix / YouTube 现代标配 | 存储减半，同一份分片同时服务 HLS 与 DASH |
| HTTP-FLV / WS-FLV | 无 | FLV 流 | 1–3s | 需 flv.js/mpegts.js 转封装 | 国内直播、监控 | FLV 标准只定义 H.264；HEVC 是 enhanced-RTMP 扩展 (codec id 12)，生态不统一 |
| WS-fMP4 / HTTP-fMP4 | 无 | fMP4 | 1–2s | MSE 直喂 | 低延迟直播、监控 | 比 FLV 干净，无需转封装 |
| MPEG-TS over WS/HTTP | 无 | TS | 1–3s | mpegts.js | 广电 / 监控 | |
| 渐进式 MP4 (faststart) | 无 | MP4 | 即时 | 全部原生 | 短视频、简单场景 | 无 ABR；xgplayer 用 MSE 做 MP4 分段加载实现无缝换清晰度 |
| WebRTC / WHEP | SDP | RTP | 0.2–0.5s | 全部 | 互动直播、电商、监控 | 无缓存、无 CDN 命中、服务端昂贵 |
| WebTransport / MoQ | 自定义 | 自定义 | <1s | Chromium | 新兴 | 2026 仍在标准化 |
| MSS (Smooth Streaming) | `.ism` | PIFF | | Shaka 支持 VOD | 遗留 | 新项目不要碰 |

### 2.2 编解码支持矩阵（2026，MSE 路径）

| 编码 | Chrome/Edge | Firefox | Safari macOS | Safari iOS | 备注 |
|---|---|---|---|---|---|
| H.264 (avc1) | 全 | 全 | 全 | 全 | 唯一无缺口组合：fMP4 + H.264 + AAC-LC |
| HEVC (hvc1/hev1) | 硬件相关 | Windows 硬件相关 | 全 | 全 | Linux 桌面 Chrome 基本无；FLV 容器 HEVC 非标 |
| AV1 (av01) | 全（70+，含软解） | 全 | Apple Silicon | A17 Pro 以上 | 压缩最好，Apple 旧设备没有 |
| VP9 | 全 | 全 | 无 | 无 | WebM/fMP4 |
| VVC/H.266 | 无 | 无 | 无 | 无 | 只能 WASM 软解，1080p 约 12–22fps，不可用 |
| LCEVC (MPEG-5 Part 2) | 需 lcevc_dec.js | 同 | 同 | 同 | Shaka 有集成 |
| AAC-LC / HE-AAC | 全 | 全 | 全 | 全 | |
| Opus | 全 | 全 | 全 (fMP4) | 16.4+ | |
| AC-3 / E-AC-3 | 部分 (Edge/Windows) | 无 | 全 | 全 | 杜比需要平台授权 |
| FLAC / ALAC | 全 / 无 | 全 / 无 | 全 / 全 | 全 / 全 | B 站 Hi-Res 用这条路 |

常用 codec 字符串：
- H.264 + AAC：`video/mp4; codecs="avc1.640028,mp4a.40.2"`
- HEVC + AAC：`video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"`
- VP9 + Opus：`video/webm; codecs="vp09.02.10.10.01.09.16.09.01,opus"`
- AV1 + Opus：`video/mp4; codecs="av01.0.05M.08,opus"`

## 3. 开源流媒体引擎

引擎层只管拉清单、拉分片、ABR、喂 MSE、DRM，不管 UI。

| 引擎 | 维护方 | 协议 | gzip 体积 | DRM | 低延迟 | 离线 | 语言 / 许可证 | 定位 |
|---|---|---|---|---|---|---|---|---|
| hls.js | video-dev 社区 (Mux/JW/Twitch 等) | HLS 独占 | ~70–155KB (light ~103KB) | EME 需自己接；FairPlay 走 Safari 原生 | LL-HLS | 无 | TS / Apache-2.0 | 事实标准，周下载约 500 万；1.5+ 支持 MMS、MediaCapabilities、HDR、AV1/HEVC/DV、CMCD、Content Steering、Interstitials |
| Shaka Player | Google | HLS + DASH + MSS | ~110–240KB (Closure 定制可到 115KB) | Widevine/PlayReady/FairPlay/ClearKey 一体化 | LL-HLS + LL-DASH | 内置 Storage API | TS / Apache-2.0 | 需要 DRM + 双协议 + 离线 + 智能电视的默认选择；YouTube TV 在用 |
| dash.js | DASH-IF | DASH 独占 (CMAF-HLS 有限) | ~140–290KB | EME | LL-DASH | 插件 | JS / BSD-3 | 标准参考实现；ABR 有 throughput/BOLA/dynamic；内存偏高 |
| VHS (video.js 8 内置) | Brightcove/Mux | HLS + DASH | ~128KB | EME 插件 | 一般 | 无 | JS / Apache | 只能跟 video.js 一起用 |
| SPF (video.js 10 新引擎) | Mux 主导 | 按需组合 (CMAF-HLS 起步) | ~12KB (简单 ABR) | 组件化按需 | 开发中 | 无 | TS / Apache | 函数式组件拼引擎，简单场景只有 hls.js-light 的 12%；GA 约 2026 年中 |
| RxPlayer | CANAL+ | DASH + HLS + MSS + 本地 | ~150KB | 多 DRM，电视强 | LL-DASH | 有 | TS / Apache | 法国 OTT 生产级 |
| mpegts.js | xqq (flv.js 原作者) | HTTP-FLV / WS-FLV / MPEG-TS | ~40KB | 无 | 追帧 + 动态倍速 + 多层看门狗 | 无 | TS / Apache | flv.js 继任者，HEVC in FLV 解析；国内直播 / 监控首选 |
| flv.js | Bilibili | HTTP-FLV / WS-FLV | ~36KB | 无 | 基础追帧 | 无 | JS / Apache | 2020 起停止维护，官方让迁 mpegts.js |
| xgplayer (-hls/-flv/-mp4/-dash) | 字节跳动 | HLS/FLV/MP4 分段/DASH | 核心 ~60KB+ | 有限 | 直播追帧 | 无 | JS / MIT | 引擎 + UI 一体，MP4 分段加载换清晰度是独门特性 |
| libmedia | zhaohappy | HLS/DASH/FLV/MP4/MKV/RTSP/WebRTC/SRT | 大 (WASM) | 无 | 有 | 无 | TS + WASM / LGPL | FFmpeg 移植 + WebCodecs 优先，格式覆盖最广 |
| Jessibuca (开源版) | langhuihui (Monibuca) | HTTP-FLV/WS-FLV/M7S | ~500KB (含 WASM) | 无 | 0 缓冲模式 | 无 | JS + WASM / GPLv3 | H.264/H.265 WASM 软解到 720p，Canvas/WebGL 渲染；Pro 版才有硬解/HLS/WebRTC |
| WXInlinePlayer | 微信团队 (已停更) | HTTP-FLV/WS | | | | | WASM libde265 | 历史价值 |

## 4. 开源 UI / 播放器框架

2026 年最大变化：video.js、Plyr、Vidstack、Media Chrome 四家合并成 video.js v10（State / Media / UI 三层解耦）。四个旧项目继续维护但方向已收敛。

| 框架 | 性质 | 默认 UI gzip | 引擎 | 框架支持 | 无障碍 | 状态 |
|---|---|---|---|---|---|---|
| video.js v8 | 一体化播放器 + 插件生态 | ~75KB (核心) + VHS 128KB | VHS 内置，可换 hls.js/Shaka | 任意，需封装 | 中 | 生产稳定线，40 万站点 |
| video.js v10 | State / Media / UI 三层，Zustand 式 store，shadcn 式无样式原语 | HTML 25KB / React 18KB；带 SPF ABR 39KB | SPF 或任意 | React + TS + Tailwind 一等公民，Web Components，Vue 规划中 | 强 | RC，GA 2026 中；34 个破坏性 API 变更 |
| Vidstack | Web Components (Lit) + React/Vue/Svelte 绑定 | ~74KB | 自动接 hls.js/dash.js | 全 | WCAG 2.2 / CVAA 合规 | 1.0 稳定，Reddit 规模验证；并入 v10 |
| Media Chrome | 纯 Web Components 无头原语 | ~41KB | 自带 hls-video / dash-video / 自定义 media element | 任意 | 强 | Mux 维护，Mux Player 默认 UI |
| Plyr | 轻量成品皮肤 | ~33KB | 需手动接 hls.js | 任意 | 中 | 2025 年中进入维护模式 |
| xgplayer | 插件化一体播放器 | 核心 ~60KB | 自家引擎 | 任意，Vue/React 示例 | 中 | 字节活跃维护，国内生态好 |
| ArtPlayer | 极简一体播放器 | ~15KB | 需手动接 hls.js/flv.js/dash.js | 任意 | 弱 | 个人项目 |
| DPlayer | 弹幕播放器 | ~30KB | 接 hls.js/flv.js/dash.js/webtorrent | 任意 | 弱 | 维护变慢，弹幕是卖点 |
| Griffith | 知乎开源 React 播放器 | | MP4/HLS | React | 中 | 功能单一 |
| Clappr | 插件化 | | 接 hls.js/dash.js | 任意 | 中 | Globo 出品，生态碎片 |
| OpenPlayerJS / MediaElement.js | 遗留兼容 | | | | | WordPress 传统线 |

## 5. 闭源 / 商业播放器

| 产品 | 厂商 | 核心卖点 | 协议 / DRM | 定价信号 | 弱点 |
|---|---|---|---|---|---|
| THEOplayer (Dolby OptiView) | Dolby | 一套 API 覆盖 Web/iOS/Android/Roku/tvOS/电视 OS；HESP 亚秒级专有协议；广告栈强 | HLS/DASH/HESP/WebRTC，多 DRM 开箱 | 约 $0.75 / 千次曝光，按设备授权 | 贵；HESP 需专用 origin |
| Bitmovin Player | Bitmovin | 与自家编码器、Analytics 深度绑定；AV1 生产多年；SGAI | HLS/DASH，多 DRM | Starter $249/月起，MAU 计费 | 需自己做 UX |
| JW Player (JWX) | JW Player | 发布商 / 广告变现一体；hls.js 主要贡献方 | HLS/DASH，DRM 含套餐 | $10–25/月起到企业 $500–5K | 电视端原生 SDK 弱 |
| Brightcove Player | Brightcove | 企业 OTT 全家桶 | HLS/DASH，多 DRM | $199/月入门，年合同 $5–15 万 | 平台锁定重 |
| Kaltura Player | Kaltura | 教育 / 政府，开源底座 playkit-js | HLS/DASH，多 DRM | ~$1K/月起 | UI 重 |
| Mux Player | Mux | Media Chrome + hls.js + Mux Data 内建 | HLS，DRM 托管 | 按分钟用量 | 只服务 Mux 托管视频 |
| Cloudflare Stream Player | Cloudflare | 与 CF 栈一体 | HLS/DASH | $5 / 千分钟存储 | 定制度低 |
| Amazon IVS Player | AWS | WASM 核心闭源 SDK，Twitch 同源，3–5s | IVS 专有 + HLS | 随 IVS 计费 | 只能播 IVS |
| 腾讯云 TCPlayer | 腾讯云 | CDN/点播/直播一体，WebRTC 快直播，小程序同源 | HLS/FLV/WebRTC/DASH，自研加密 + 商业 DRM | 随云服务 | 闭源绑定 |
| 阿里云 Aliplayer | 阿里云 | ARTC 低延迟、私有加密、H.265 软解 | HLS/FLV/MP4/ARTC/DASH | 随云服务 | 同上 |
| 保利威 / 百家云等 | 各家 | 教育防录屏、跑马灯、水印 | HLS 私有加密 | 套餐 | 封闭 |
| Jessibuca Pro / EasyPlayer Pro | Monibuca / EasyDarwin | 监控大屏：H.265 硬解、SIMD 多线程、GB28181 回放、SM4 加密流、PTZ、16 路并发 | HTTP-FLV/WS-FLV/HLS/WebRTC/WebTransport/TS/PS | 一次性授权 | 面向安防 |

## 6. 大厂自研播放器可借鉴的设计

| 平台 | 做法 | 借鉴点 |
|---|---|---|
| YouTube | DASH over MSE，VP9/AV1 优先，Safari 回退 HLS；自研 ABR，近年把码率决策搬到服务端（SABR / UMP） | 服务端参与 ABR、精细 MediaCapabilities 探测、极端首帧优化（并发 init + 首片） |
| Netflix | Cadmium JS 播放器，MSE + EME，CMAF cbcs 一份分片出 HLS/DASH，DRM 按浏览器分发 | 一次打包多清单、DRM 与 ABR 解耦、Per-title 编码阶梯 |
| Bilibili | 闭源 nano 播放器 (`window.nano.createPlayer`)；FLV (2016 开源 flv.js) 到 2018 切 DASH；音视频完全分离的 `.m4s` 由前端双 SourceBuffer 组合；`fnval` 位掩码协商（16=DASH, 64=HDR/DV, 128=4K, 256=AV1）；H.264/HEVC/AV1 三轨并行，Hi-Res FLAC 与全景声；iOS 早期走 MP4 直链与 HLS，MMS 后可走 DASH；弹幕独立渲染层（高级弹幕、蒙版弹幕用 WebGL/Canvas）；播放器分 core / npd 控件 / video 三段懒加载；PC 客户端 (Electron) 直接复用 Web nano | 音视频分离节省转码与存储、弹幕独立渲染层、播放器分段懒加载、画质偏好本地持久化 |
| 抖音 / 西瓜 | xgplayer 开源 UI 与引擎大部分；MP4 分段加载换清晰度 | 对没有 ABR 的 MP4 库存的务实解法 |
| Twitch | 自研 HLS 播放器，核心逻辑编译成 WASM，商业化为 Amazon IVS Player | 核心引擎用 WASM 保护逻辑且跨平台复用 |
| 腾讯视频 / 爱奇艺 / 优酷 | HLS 私有加密为主，商业 DRM，自研 P2P-CDN 插件（WebRTC DataChannel 分发分片） | 国内长视频的共同特征 |

## 7. 自研前必须回答的三个问题

1. 目标格式集合：只 HLS？HLS + DASH？要不要 FLV 直播？要不要 WebRTC？每加一种都多一个 demuxer 和一套错误恢复。
2. 是否绕过 `<video>`：只有需要浏览器不支持的编码、逐帧精控、或 16 路监控大屏时，才值得走 WebCodecs + WebGL；否则 MSE 稳定性和功耗好一个量级。
3. DRM 要不要：要就 Shaka 打底，别自己写 EME 流程。

自研最容易低估的七项：MSE 的 `updating` 排队与配额驱逐；iPhone MMS 的 AirPlay 条件；跨 codec 切档；字幕 (WebVTT/IMSC1/CEA-608) 渲染与无障碍；缓冲空洞与 `bufferStalledError` 恢复；QoE 遥测；CSP 下 Worker 的 `blob:` 许可。

## 8. 参考来源

- Fora Soft：Web Playback: HTML5, MSE, EME & Web Players — https://www.forasoft.com/learn/ott/articles-ott/web-playback-html5-mse-eme-players
- Fora Soft：Custom Video Player Development: A 2026 Build Guide — https://forasoft.com/blog/article/custom-video-player-development
- Fora Soft：iOS and Safari: The Native Player You Can't Escape — https://www.forasoft.com/learn/video-streaming/articles-streaming/ios-safari-native-player
- Fora Soft：Video.js v10 and the Streaming Processor Framework — https://www.forasoft.com/learn/video-streaming/articles-streaming/video-js-v10-spf
- Mux：Video.js v10 Beta: Hello, World (again) — https://data.mux.com/blog/video-js-v10-beta-hello-world-again
- Video.js v10 RC 报道 — https://www.streamingmeme.com/articles/video-js-v10-release-candidate-slashes-bundle-sizes-by-60-percent
- hls.js v1.5.0 Release Notes — https://github.com/video-dev/hls.js/releases/tag/v1.5.0
- LiveAPI：hls.js 指南 — https://liveapi.com/blog/hls-js
- LiveAPI：HLS vs DASH — https://liveapi.com/blog/hls-vs-dash/
- media-delivery.com：Adaptive Bitrate Streaming with HLS and DASH — https://www.media-delivery.com/responsive-image-video-delivery/adaptive-bitrate-streaming-with-hls-and-dash
- Shaka Player README 功能矩阵 — https://github.com/shaka-project/shaka-player
- caniuse：ManagedMediaSource — https://caniuse.com/mdn-api_managedmediasource
- dev.to：Open-Source Web Video Players for OTT — https://dev.to/braggio/the-beginners-guide-to-open-source-web-video-players-for-ott-front-end-developers-3l9k
- CSDN：FLV.js 与 mpegts.js 深度对比 — https://blog.csdn.net/qq_53245353/article/details/156393664
- DeepWiki：bytedance/xgplayer — https://deepwiki.com/bytedance/xgplayer/1-overview
- dev.to：Bilibili DASH / WBI 解析 — https://dev.to/yqqwe/engineering-a-high-performance-bilibili-video-downloader-a-deep-dive-into-dash-wbi-signatures-3po1
- B 站 PC 客户端架构设计（nano 复用） — https://www.idc.net/help/331402/
- H.264 / H.265 / H.266 Web 前端播放选型 2026 — https://blog.mickeyzzc.tech/en/posts/network/web-video-codec-survey
- DeepWiki：langhuihui/jessibuca — https://deepwiki.com/langhuihui/jessibuca
- webcodecsfundamentals：How to build a Video Player in WebCodecs — https://webcodecsfundamentals.org/patterns/playback
- Fora Soft：Enterprise Video Platform Build vs Buy（商业播放器对比） — https://forasoft.com/blog/article/enterprise-video-platform-dev
