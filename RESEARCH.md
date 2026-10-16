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
