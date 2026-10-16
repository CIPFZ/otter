# ADR-003：M1 引擎接入契约（Engine、FormatPlugin、MediaBackend、播放会话、vendoring 布局）

- 状态：已采纳
- 日期：2026-10-15
- 关联：`SPEC.md` §3、§5、§6、§8、§10、§19、§21；`REUSE.md` §3、§5；ADR-002

## 背景

M0 的 `Engine` 是临时定义（`load` / `destroy`），`FormatPlugin` 无法告诉选路器自己能喂哪些 backend，`MediaBackend` 缺少音量、静音、倍速和播放状态事件；而且没有组件负责「store action → backend」这一段。M1 要接 hls.js、Shaka、mpegts.js 三个真实引擎，并且第一次引入第三方运行时依赖和 L3 复制代码，这些都需要先定下来。

## 决策

### 1. 分层与数据流

```
UI / Overlay / Presentation ──dispatch──▶ store ──action handler──▶ 播放会话（media plugin）
          ▲                                                              │
          └──────────── 只读 state ◀── setState ◀── BackendEvents ◀── MediaBackend ── <video> / Engine
```

- 只有 `MediaBackend` 实现可以接触 `<video>`。播放会话本身也不直接操作元素，只调用 backend 的方法、监听 `BackendEvents`。
- 播放会话是一个 core `Plugin`：`createMediaPlugin()` 位于 `media` 包，负责能力探测、选路、创建 backend、加载、降级重试、把 backend 事件写回 store，以及发出 QoE 事件（§10）。
- `dispatch` 同步执行到 backend 方法，所以 `play()` 等调用仍然处在用户手势的调用栈内。

### 2. `MediaBackend` 补充（SPEC §5）

- 新增 `setVolume(v)`、`setMuted(m)`、`setPlaybackRate(r)`。
- `BackendEvents` 新增：
  - `playback-change`（`Partial<PlaybackSnapshot>`：paused / ended / seeking / waiting / currentTime / duration / volume / muted / playbackRate / videoWidth / videoHeight / readyState）；
  - `first-frame`、`first-segment`（QoE startup 用）；
  - `bandwidth`、`dropped-frames`。
- backend 由 `BackendFactory { kind, create(ctx: BackendContext) }` 创建。`BackendContext` 携带选路结果（format、step、caps、qoe），一个 backend 实例只服务一次选路决策。
- `media` 包提供 `observeMediaElement(element, emit)`，供 native 与 mse 两个 backend 共用，把元素事件映射为 `BackendEvents`。

### 3. `FormatPlugin` 与 `Engine`

- `FormatPlugin.backends(source, caps): readonly BackendKind[]`：这个格式对该源能喂哪些 backend（例如 HLS：Safari 原生可播时含 `native`，有 MSE / MMS 时含 `mse`）。选路器只在这个集合内挑选。
- `EngineContext` 增加 `media: HTMLMediaElement`、`mms: boolean`、`allowCodecSwitch: boolean`。
- `Engine` 定稿：`formatId`、`tracks`、`latency?`、`load()`、`selectQuality(id | 'auto')`、`on(EngineEvents)`、`destroy()`。M1 的三个 adapter 都由引擎库自己管理 MSE（attach 到 `ctx.media`）。M3 自研管线换成 MediaSource sink 的接法时，在 `EngineContext` 上新增可选字段，不破坏已有 adapter。
- 引擎库在 `Engine.load()` 里通过 `import()` 动态加载。adapter 包本身只有胶水代码，构建产物里引擎库保持 external。
- 格式到引擎的映射：
  - `format-hls`：默认 hls.js；源带 `drm` 时改走 Shaka（DRM 只经 Shaka，AGENT §6）。
  - `format-dash`：Shaka。
  - `format-flv` / `format-ts`：mpegts.js（M3 换自研管线）。
  - `format-mp4-range`：M1 只提供 `native`，Range 分段加载在 M3 实现。

### 4. 选路算法（SPEC §5.2 的确定性实现）

1. 对所有 FormatPlugin 调用 `probe` 打分，取最高分；同分保持注册顺序；最高分为 0 时以 `noFormat` 失败。
2. 平台判定：
   - `mediaSource === false && managedMediaSource === true` 视为 iPhone（iOS 17.1+）；
   - 两者都没有、只有 `nativeHls` 时，视为旧版 iPhone。
3. 初始候选顺序：
   - iPhone、HLS、无 DRM、`needsQualitySwitch` 为 false：`native → mse`；
   - iPhone 的其他情况：`mse → native`；
   - `source.codecs` 含 HEVC 且 `caps.codecs` 显示不支持（或无硬解）：`webcodecs(webcodecs) → webcodecs(wasm) → mse → native`；
   - 其他：`mse → native`。
4. 依次过滤：`forbidBackend`；`format.backends()`；backend 是否已注册；能力是否具备（mse 需要 MSE 或 MMS，webcodecs 需要 `VideoDecoder`）。每次排除都写一条 `RouteStep`（`rejected` + 原因）。
5. `preferBackend` 若仍可行，提到最前。
6. 选中第一个候选；其余按顺序作为 `remaining`。`fallback()` 取 `remaining` 的下一项，并把失败的那一步记为 `failed`。
7. 每次决策都发出 `route` QoE 事件，并写入 store 的 `route`。`router.explain()` 返回最近一次决策。

### 5. MMS 与 AirPlay（SPEC §6.2，RESEARCH §1）

`backend-mse` 对所有引擎统一处理，不依赖各引擎各自的实现：

- 使用 MMS 的条件：`managedMediaSource && (!mediaSource || preferManagedMediaSource)`。
- 有 AirPlay 备用源时（`source.airplaySrc`，或源本身就是 HLS URL）：在引擎 attach 之后补上 `<source type="application/vnd.apple.mpegurl">`，并把 `disableRemotePlayback` 设为 `false`。hls.js 在 attach 时会清掉已有的 `<source>` 并强制设为 `true`，所以必须放在 attach 之后做。
- 没有备用源时：attach 之前就设 `disableRemotePlayback = true`，否则 iPhone 上 MMS 会静默不启动。
- 决策结果写进 `RouteStep`（`mms: airplay-alternate` 或 `mms: disableRemotePlayback`）。
- `<source>` 辅助函数取自 hls.js（L3，见第 7 条）。

### 6. store 契约

- state 键：`status`、`source`、`paused`、`ended`、`seeking`、`waiting`、`currentTime`、`duration`、`bufferedEnd`、`volume`、`muted`、`playbackRate`、`live`、`latency`、`videoWidth`、`videoHeight`、`tracks`、`quality`、`activeQuality`、`backend`、`format`、`route`、`mms`、`remotePlayback`、`error`；`qoe` 插件额外写入 `qoe`（`QoeSnapshot`）。
- 会话处理的 action：
  - `load`、`unload`、`play`、`pause`、`seek`、`set-volume`、`set-muted`、`set-playback-rate`、`select-quality`；
  - 以及 `InputActionMap` 中属于媒体控制的：`toggle-paused`、`seek-by`、`seek-to-percent`、`toggle-muted`、`volume-by`、`hold-rate`。
- 全屏、PiP、字幕、小窗等 action 归 presentation / text 处理（M2、M3）。

### 7. vendoring 布局与门禁（REUSE §5）

- L2（整个子包）放根目录 `vendor/<project>/`；L3（文件级）放使用它的包内 `src/vendor/<project>/`，测试资产放 `e2e/vendor/<project>/`。每个目录都要有 `UPSTREAM.json`：`{ project, repo, commit, license, level, files: [{ upstream, local }], localChanges }`。
- 每个复制文件头部逐个列出来源：`// Derived from <project>@<commit> <path>, <license>`。
- `scripts/check-vendor.ts`（CI 阻断）检查：
  - 头部与 `UPSTREAM.json` 一致；目录中没有未登记的文件；
  - 许可证允许 L2 / L3（只限 Apache-2.0 / MIT / BSD）；
  - 项目已列在 `REUSE.md` 与 `THIRD_PARTY_NOTICES.md` 中；
  - 每个 workspace 包的第三方运行时依赖（L1）都已列在 `THIRD_PARTY_NOTICES.md` 的运行时依赖表和 `REUSE.md` 中。
- `scripts/vendor-sync.ts`（联网、手动或定时运行）：对比固定 commit 与上游默认分支，输出漂移报告。

### 8. 测试媒体与场景矩阵

- 确定性测试使用 ffmpeg 生成、提交进仓库的小样本（`e2e/media/`，生成脚本一同提交）：MP4、HLS（TS 与 fMP4，多码率 + WebVTT）、DASH（音视频分离）、ClearKey 加密 DASH、FLV、TS。
- 公网流（直播、LL-HLS / LL-DASH、ClearKey 许可证服务器）来自 hls.js / Shaka 的测试清单（L3），标记为 `@network`。网络不可达时这类失败不能当作产品缺陷，但也必须如实报告。
- SPEC §19 中依赖后续里程碑模块的场景（HEVC 软解与 GPUSurface 为 M4，弹幕为 M5，TV 皮肤为 M6，逐帧为 M4），M1 只验收其中的播放部分，矩阵文件逐行标明这一点。

### 9. 体积

- §1.1 预算（core、skin + ui-core + presentation + text、danmaku）继续阻断。
- 引擎库体积按场景如实报告（含 / 不含动态加载的引擎块）。用 L1 适配器时，§19 中 HLS / DASH 场景的目标（< 80 KB 等）达不到，这是「先适配后替换」的已知代价，SPEC §21 安排在 M6 达标。在 M1 中这一冲突需要用户确认，不能视为已满足。

## 代价

- `MediaBackend` 与 `FormatPlugin` 接口扩充，影响 M0 的空实现与契约测试（同步更新）。
- 由 backend 统一处理 MMS / AirPlay，与引擎各自的逻辑存在重叠；hls.js 在 attach 时的强制行为要求我们在 attach 之后再修正。这一行为必须在真机 iPhone 上验证，M1 验收已包含真机要求。

## 实现中补充（2026-10-16）

在真实浏览器矩阵中发现、实现时补进契约的部分：

- `Engine.mms`：引擎实际是否在用 ManagedMediaSource（Shaka 只要存在 MMS 就会用，hls.js 看 `preferManagedMediaSource`）。backend-mse 以它为准完成 AirPlay / `disableRemotePlayback` 处理。
- `BackendEvents['remote-playback']`：`{ mms, remotePlayback, reason }`；会话把它写进 store 的 `mms` / `remotePlayback`，并作为一条 `RouteStep` 追加到 `router.explain()`（`Router.annotate`）。
- 直播延迟：不再转发各引擎各自节奏的延迟事件，由 backend-mse 在 `timeupdate` 时按 1 次/秒读取 `engine.latency`（`readyState >= 2`，丢弃 > 1 小时的值），三个引擎行为一致。
- 初始档位：会话从 `tracks-change` 中 `selected` 的视频轨取得 `activeQuality`；初始选定不计为 `quality-switch`。
- 手动切档立即生效（hls.js 用 `currentLevel`，Shaka 用 `selectVariantTrack(t, true)`），`auto` 回到 ABR 且不清空缓冲。
- `DrmConfig.servers` 为 `Partial`；新增 `DrmConfig.clearKeys`（映射 Shaka `drm.clearKeys`），只有 clearKeys 时也会探测 `org.w3.clearkey`。
- `Surface.destroy()`（SPEC §12 已同步）。
- Shaka / mpegts.js 的 CommonJS 命名空间声明在 NodeNext 下无法正确解析，adapter 以结构化类型描述用到的 API 子集，并兼容 `mod` / `mod.default` / `mod.default.default` 三种互操作形态。
