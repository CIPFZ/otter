# ADR-010：自研 CMAF-HLS 引擎：独立实现，按 L3 拷 SPF 的纯函数层（Q3 结案）

- 状态：已采纳
- 日期：2026-10-21
- 关联：`SPEC.md` §8、§19、§23 Q3；ADR-011（M5 批次）；`docs/reports/M4.md`「M4 → M5 交接」；`REUSE.md` §3；ADR-009（体积口径修订）；`docs/reports/M4.md`「Q3 材料」

## 背景

ADR-009 把自研轻量 CMAF-HLS 引擎提前到 M5，并要求 Q3（与 video.js 10 的 SPF 是什么关系）在 M4 收尾时结案。M4 报告的 Q3 材料逐个文件看了 `@videojs/spf` 10.1.0（video.js@92be7bd）：

- SPF 分两层。`media/`、`network/` 下多数文件是纯函数（m3u8 解析、缓冲计划、重载策略、fMP4 box 读取），可以单独拷；`playback/`、`core/` 建立在 SPF 自己的 signals / actor / reactor / composition 运行时上，拷不出来。
- Otter 已有引擎需要的运行时部件：MSE sink、ABR 规则栈、LiveController、适配器回退。缺的是播放列表加载与刷新、分片调度器和直播可拖范围；`format-mp4-range` 的引擎与要写的调度器结构相同。
- 体积：SPF 的 HLS 视频引擎实测约 28 KB gzip（不含 `signal-polyfill`），SPEC 里「SPF 12 KB」找不到出处；按下面的方式拼装，估计点播 10–12 KB、含直播 13–14.5 KB。

## 决定

### 1. 方案 A：独立实现，不依赖 SPF 运行时

- **L3 拷入 SPF**（文件级复制，带 `// Derived from videojs/video.js@<commit> packages/spf/src/<path>` 头和 `UPSTREAM.json`，跟随 vendor-sync）：
  - m3u8 解析：`media/hls/parse-attributes.ts`、`resolve-url.ts`、`parse-multivariant.ts`、`parse-media-playlist.ts`，以及它们用到的 `media/types` 子集与 `media/utils/tracks.ts` 中的 codec 工具；
  - 缓冲计划：`media/buffer/forward-buffer.ts`、`back-buffer.ts`；
  - 重载策略与直播窗口：`media/hls/reload-policy.ts`、`media/live-window.ts`；
  - `tfdt` 读取：`media/mp4/box.ts`、`timestamp-origin.ts`；结束判断 `media/dom/mse/end-of-stream.ts`；
  - 上述文件的测试（`parse-media-playlist`、`parse-multivariant`、`forward-buffer`、`back-buffer` 共约 140 个用例）和 m3u8 夹具，改成 Otter 的 Vitest 路径后一并拷入。
  - `@videojs/utils` 的 `generateId` / `isUndefined` 换成本地小实现；CMAF-HAM 类型保留拷入的子集，引擎边界上转换成 Otter 的 `TrackList`。
- **复用 Otter 已有部件，不拷 SPF 的对应部分**：`engine-pipeline` 的 MSE sink 与 `withAdapterFallback`、`pipeline` 的 ABR 规则栈（`createAbrDriver`）与 LiveController、`backend-mse`（含 MMS / AirPlay 前提）。
- **新写**：播放列表加载与刷新循环、分片调度器（参照 `format-mp4-range/src/engine.ts` 的 epoch / pump / step 结构）、分片账本（MSE sink 只有时间区间）、variant 按 codec 过滤、轨道映射、直播起播位置与 `setLiveSeekableRange`。SPF 的 `segment-loader.ts` 里 `planTasks` 可按 L3 抽出。

### 2. 附加决定

- **范围**：点播与直播一起做（M5 首批）。
- **时间线**：非零起始 PTS 不平移（不用 `timestampOffset` 移到 0），与 Otter 现有引擎（mp4-range、FLV / TS 管线）一致，媒体时间就是流的时间。
- **位置**：引擎是 `format-hls` 内的按需块（`import()`），不另建包；`format-hls` 根据清单决定用自研引擎还是 hls.js，自研引擎外面包 `withAdapterFallback`。
- **不支持的一律交 hls.js**：`EXT-X-DISCONTINUITY`、AES-128（非 DRM 的 `EXT-X-KEY`）、TS 分片、LL-HLS part、I-frame 清单（缩略图）。解析阶段发现即报「不支持」（带原因写进 `router.explain()`），由 `format-hls` 选 hls.js；不在自研引擎里做半套支持。DRM 仍只走 Shaka（SPEC §7）。

### 3. 体积口径（修订 ADR-009）

ADR-009 的「含引擎口径简单点播 < 30KB」与现状冲突：短视频场景自有代码已 25.88 KB，引擎块只剩约 4 KB。改为两条独立门禁：

- **自有代码**：各场景上限不变（短视频 ≤ 30 KB 等），M1–M6 门禁。
- **自研引擎块**（`format-hls` 的引擎按需块及其独有依赖，gzip）：只点播 ≤ 12 KB，含直播 ≤ 15 KB，M5 起门禁。
- **「含第三方引擎」列**：继续只记录，到 M6。

SPEC §8 的「对标 SPF 12KB」改成这两个数字。引擎块的 size-limit 条目随引擎在 M5 加入 `.size-limit.js`（与 §19 场景并列，两档上限）。

M5 实现时的口径（2026-10-22）：

- **两条门禁各量什么**：
  - 「点播」量每次点播播放都会加载的引擎块（`engine-*.js`）及其独有依赖：MSE sink、ABR 规则栈。`@otter-player/core` 首屏已有，不计。
  - 「含直播」量引擎的全部按需块：引擎块，加上直播块（LiveController、重载策略），再加上打开 WebVTT 字幕时才加载的字幕块。
- **ABR 用精简规则栈**：Throughput + InsufficientBuffer（`createLeanAbrController`），不带 BOLA 与 Dynamic 切换，比完整规则栈轻约 1.4 KB。hls.js 适配器、Shaka、mp4-range 仍用完整规则栈。为此 `createAbrDriverWith(controller)` 与带默认规则栈的 `createAbrDriver` 分开，精简栈不会带上 BOLA。
- **模块边界**：
  - 引擎块不直接引用 `@otter-player/core` 的值，由按需包装层传入（`CoreHelpers`）。
  - sink 与 `withAdapterFallback` 各走 `@otter-player/engine-pipeline` 的子路径（`/sink`、`/fallback`）。
  - 这样首屏入口和引擎块不会共享同一个模块，副作用门禁（单文件打包时的惰性初始化）保持干净。
- **余量规则**（2026-10-22 负责人）：点播引擎块只剩约 160 B，引擎今后的新路径一律做成按需块，不进引擎块；压缩引擎块记为 M6 待办（SPEC §21 M6 行）。
- **待办**：`CLOSED-CAPTIONS`（fMP4 视频里的 CEA-608）现在交 hls.js。以后在字幕块里从 `mdat` 的 SEI 取 cc_data，接已有的 `cea-608-parser`（hls.js L2 拷贝）。

### 4. 接口改动（M4 → M5 交接，2026-10-22 负责人确认）

M4 报告「M4 → M5 交接」的五条建议全部采纳，在拷入 SPF 与写调度器之前单独提交：

1. **Engine / EngineContext**：EngineContext 不加字段。`Engine` 加可选 `readonly targetLatency?: number`；`backend-mse` 采样延迟时一起读，`latency-change` 带上 `target`（hls.js 适配器同样受益）。
2. **MSE sink**：
   - **分片账本**：`append(type, data, seg?: { id, start, end, level })`；`evict` / `clear` / 浏览器自行驱逐后按 `buffered` 修剪；查询接口 `segments(type)`。
   - **`abort(type)`**：清掉该队列未执行的操作（Promise 以 `AbortError` 结束），正在追加时调用 `SourceBuffer.abort()`，之后下一段前须重新追加 init。
   - **不加 timestampOffset**：与上面「PTS 不平移」一致。
3. **withAdapterFallback**：
   - **新的回退触发**：新增 details `ownEngineUnsupported`（`type: 'media'`）触发回退，原因写在 `pipelineFallback` 的 message 里，由 `backend-mse` 记成 `router.explain()` 的一步。`unsupportedSource` 与网络错误仍不回退。
   - **运行时回退一次**：`load()` 之后的致命媒体错误，从当前位置用适配器重建一次。重建时**保留用户已选的清晰度、字幕轨和音轨**：手动选了某档就仍是那一档，不回自动档；自动档仍是自动档。字幕与音轨按 id 选回，适配器里没有同 id 的，按语言加类型匹配，再不行保持适配器默认并在 `pipelineFallback` 的 message 里说明。
4. **ABR driver**：接口不改。
   - `sampleDownload(ms, bytes, ttfbMs)`：每个媒体分片下载完时调用（不含 init 和播放列表）。
   - `decide`：选下一个视频分片前调用，前向缓冲取视频 SourceBuffer，`segmentDuration` 取 TARGETDURATION。
   - `segmentAppended`：视频分片追加后调用。
   - `applied`：切档后调用。
   - `reset`：seek 时调用。
   - 切档点不早于「时钟 + 1 s」的分片边界。
5. **LiveController**：
   - **`setTargetLatency(s)`**：重算阈值。目标取 `HOLD-BACK`，缺省 3 × TARGETDURATION，宿主可用 `createHlsFormat({ targetLatency })` 覆盖。
   - **`LiveSample.edge?`**：直播边缘的媒体时间。有它时 `chaseLatency` / `syncRate` / `seekToLive` 用它代替缓冲末尾；FLV / TS 不传，行为不变。
   - **起播位置**：`edge − HOLD-BACK`，由引擎设置。

直播可拖范围随引擎首批做：引擎调用 `setLiveSeekableRange`，`PlaybackSnapshot` 增加 `seekableStart` / `seekableEnd`（ADR-011）。

## 代价

- 拷入约 1,500 行要跟上游：SPF 发版频繁（2026-10 一个月内 10.0.0、10.0.1、10.1.0），vendor-sync 会报告漂移，需要定期评审。
- 不支持的情况全部回退 hls.js：带不连续点、AES-128、TS 分片的 HLS 不会享受到自研引擎的体积，首播仍加载 hls.js。
- 不平移 PTS：非零起始的流在进度条上不是从 0 开始，UI 与 `seekable` 要按 `buffered` / 清单起点处理（mp4-range 与 FLV / TS 已是如此）。
