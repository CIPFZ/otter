# ADR-010：自研 CMAF-HLS 引擎：独立实现，按 L3 拷 SPF 的纯函数层（Q3 结案）

- 状态：已采纳；2026-10-27 再修订 §3：「引擎全部块」门禁 16.5 KB → 15.75 KB（M6 第一批收口的实测值向上取整，见 §3 末）；2026-10-23 修订 §3：「引擎全部块」门禁 15 KB → 16.5 KB，计入下载中途放弃块（M5 第一批基准暴露的必要能力：1 Mbps 下没有它，rebuffer 是 hls.js 的近 5 倍），放弃块另设 1.5 KB 上限
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
- **自研引擎块**（`format-hls` 的引擎按需块及其独有依赖，gzip）：只点播 ≤ 12 KB，含直播 ≤ 15 KB，M5 起门禁。（2026-10-23 修订：「含直播」改为「引擎全部块」≤ 16.5 KB，见下文 M5 口径。）
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
- **放弃块与全部块上限**（2026-10-23 负责人）：
  - 下载中途放弃块（`abandon-*.js`，只在多档位清单时加载）计入「引擎全部块」门禁，该门禁上限 15 KB → 16.5 KB。理由：第一批基准表明这是必要能力，1 Mbps 长视频没有它，rebuffer 总时长 3.16 s，hls.js 0.67 s。
  - 放弃块另设一条门禁，≤ 1.5 KB。
  - 点播块只剩约 2 B 余量、全部块压回 15 KB，两件都列入 M6 体积收口待办，M5 不动。
- **独立音频 rendition（2026-10-26，正确性修复，门禁不变）**：起播时所有加载线的 init 一起建 SourceBuffer（Chromium 在任一 SourceBuffer 收到媒体数据后拒绝 `addSourceBuffer`；原来独立音频的流在 Chromium 上会交给 hls.js）。所需字节由「把只用于直播的 `align()` 移进直播块」抵掉，点播块 11,995 → 11,938 B，12 KB 门禁不变。
- **余量规则**（2026-10-22 负责人）：点播引擎块只剩约 160 B，引擎今后的新路径一律做成按需块，不进引擎块；压缩引擎块记为 M6 待办（SPEC §21 M6 行）。
- **M6 收口（2026-10-27 负责人，ADR-013 第一批）**：全部块门禁 16.5 KB → **15.75 KB**，与代码同一提交改。目标原为 15 KB，压到 15,666 B 为止，按决定「压不到就定在实测值向上取整到 0.25 KB」。
  - 做了的：
    - EWMA 两个类改写为一个闭包（M5 复测时，`9715ba5`）；
    - SPF 解析器里自研引擎用不到的部分（密钥、非 fMP4 改标、SESSION-DATA）移到 `parse-full.ts`，`1912fe5`，16,206 → 15,864 B；
    - 直播块改用同一个引擎视图（`EngineInner`），不另建一套钩子；
    - format-hls 内部对象的字段统一加 `_` 前缀，构建时用 esbuild `mangleProps: /^_/` 改成短名，四个块共用一个提交在仓库的 mangle cache（`packages/format-hls/mangle-cache.json`），15,864 → 15,666 B。
  - 没做的：
    - 拆分 sink 的账本（原候选 3）只把字节从点播块挪到另一个块，对全部块无效，只对点播块有用；
    - 精简追帧控制器（原候选 c）被否决：LiveController 是三条直播管线（HLS、FLV、TS）共用的追帧与 DVR seek 实现，不分叉；
    - SPF 类型（Segment、Track 等）与 hls.js 放弃规则快照的字段名也能混淆，再省约 0.2 KB，但要大改 L3 拷贝与上游测试，也到不了 15 KB，所以没做。
  - 实测：点播块 11,477 B（12 KB 门禁），全部块 15,666 B，放弃块 1,114 B。
  - 发布形态的检查：CI 另跑一步，用构建后的 format-hls（`OTTER_E2E_DIST=format-hls`）跑自研 HLS 的 e2e。
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
