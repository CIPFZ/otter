# ADR-011：M5 批次与范围（DVR、画布 SDR 色彩管理），M4 收尾决定

- 状态：已采纳
- 日期：2026-10-22
- 关联：`SPEC.md` §5、§12、§15、§21；ADR-008（M4 契约）；ADR-010（自研 CMAF-HLS 引擎）；`docs/reports/M4.md`

## 背景

M4 于 2026-10-22 验收通过。M4 报告末尾的五个问题由负责人逐条决定，同时给出 M5 的批次顺序。本 ADR 记录这些决定；引擎接口的改动见 ADR-010 §4。

## 决定

### 1. M5 批次（每批一到三项一停，直接提交 main，CI 绿，报告 `docs/reports/M5.md`）

1. **自研 CMAF-HLS 引擎**（ADR-010 方案 A）。
   - **顺序**：先做 ADR-010 §4 的五处接口改动并单独提交；再拷 SPF 的解析器、缓冲计划、重载策略、`tfdt` 读取及其测试；然后新写调度器，接 ABR driver、LiveController、`withAdapterFallback`。
   - **范围**：点播与直播一起做，PTS 不平移；五类不支持的流（DISCONTINUITY、AES-128、TS 分片、LL-HLS part、I-frame 清单）交 hls.js。
   - **验收**：
     - §19 短视频与长视频点播场景替换 hls.js 后，TTFF 与 rebuffer 不劣于适配器（对照基准用 cn-live 那套方法：同机、同源、各跑 N 次取中位数）；
     - 直播延迟与 hls.js 持平或更好；
     - 引擎块点播 ≤ 12 KB、含直播 ≤ 15 KB 进 size-limit 门禁；
     - SPF 拷入的测试全部通过；
     - 五类不支持的流确实回退到 hls.js，且有 e2e。
2. **DVR 时间条、画布 SDR 色彩管理**（引擎之后、弹幕之前）。
3. **DASH 音视频分离优化、多编码探测与偏好持久化**。
4. **弹幕引擎（Canvas + WebGL + 蒙版）、水印**。验收：5000 条/分钟 60 fps，蒙版对齐。

### 2. 直播 DVR

- **随引擎首批**：引擎调用 `MediaSource.setLiveSeekableRange`；`PlaybackSnapshot` 增加 `seekableStart` / `seekableEnd`（点播为 0 与 duration，直播为可拖窗口，没有时为 null）。
- **第二批（UI）**：直播时时间条可拖，显示落后秒数（「−12 s」），有「回到直播」。
  - 实现（2026-10-23）：
    - 时间条在直播时以 `[seekableStart, seekableEnd]` 为范围，窗口不足 1 s 时禁用。直播的渲染、预览卡标签（「−14.0 s」）、读屏「Behind live 14 seconds」都在 `live-view` 按需块里，首屏不增加（25.98 KB）。
    - 直播标签后显示落后秒数，取引擎修正后的 edge（`state.latency`）。「回到直播」胶囊的触发条件改为比引擎的目标延迟（`state.targetLatency`，新增）多落后 3 s 以上。
    - backend-mse 的延迟采样从每秒 1 次改为 4 次。FLV / TS 管线的可拖窗口就是已缓冲范围（`setLiveSeekableRange`）。
    - e2e `e2e/dvr.spec.ts`：落后秒数与画面帧号算出的墙钟延迟之差 < 0.5 s，在目标延迟处和拖到窗口起点后各核对一次，三个项目通过。
  - 修正（2026-10-23，CI WebKit 暴露）：
    - **用户拖动后保持位置**：LiveController 沿用 mpegts.js 的追帧与起播卡顿跳转规则，拖到窗口靠前处后，一旦继续播放就被追回目标延迟；拖到已缓冲范围之前时，起播卡顿规则把播放头跳到缓冲起点。现在控制器区分自己发起的 seek 和用户的 seek（`seeking(time)`）：可播放之后的用户 seek 暂停追帧、倍速同步与卡顿跳转，倍速回到 1，直到「回到直播」或播放头重新回到目标 + 1 s 以内。有 edge（HLS，引擎会补载）时卡顿跳转只用于起播。FLV / TS 同样适用。
    - **采样节流留余量**：节流判断改为 0.8 × 250 ms，定时器略早触发时不再整拍跳过（原来暂停时实际约 2 次/秒）。
    - **e2e 读帧号改在页面内**：原来截图后再读时钟，WebKit 上截图耗时把 0.5–0.9 s 加进了播放中的墙钟延迟；现在在页面里把 `<video>` 画到画布读帧号，与落后秒数、时钟同一时刻读取。另加一步：拖动后继续播放 3 s，延迟变化 < 1 s、倍速为 1。

### 3. 画布 SDR 色彩管理（第二批）

- GPUSurface 与 CanvasSurface 按 `VideoFrame.colorSpace` 在 shader 里做 BT.601 / BT.709 矩阵与 limited / full range 到 sRGB 的转换。I420 帧（WASM 解码）按解码器报告的色彩信息；未标注时按分辨率推定（SD 用 601，HD 用 709），与浏览器对 `<video>` 的默认一致。
- 实现（2026-10-23，`packages/surface/src/color.ts`）：
  - **何时转换**：只在平台本身给 `<video>` 做色彩管理时转换，否则画面面会反过来与 `<video>` 不一致。判断依据（RESEARCH §1）：Chromium 在 GPU 合成时转换、软件合成（SwiftShader，无头 Chrome）时不转换；WebKit 转换。实现上看 WebGL 渲染器名是否为软件渲染。另外各绘制路径先用一个打了 SMPTE 170M 标签的红色小帧探测：路径自己已经转换（WebKit 的 2D canvas）就不再转换。
  - **原色**：帧的标签；YUV 帧没有标签时按高度推定（< 720 行 SMPTE 170M，否则 BT.709）；RGB 帧没有标签视为已在显示色域（Firefox 的帧）。转换只涉及 SMPTE 170M 与 BT.470BG 两种 SD 原色，BT.709 与 sRGB 原色相同；BT.2020 等宽色域不转换（只做 SDR）。
  - **算法**：sRGB 曲线线性化 → 原色矩阵 → sRGB 曲线编码，与 Edge `<video>` 的结果逐个色彩条一致到个位。GPUSurface 在 fragment shader 的取样函数里做（锐化取的邻点也一样转换）；CanvasSurface 用 `ctx.filter` 引用一个 `linearRGB` 的 SVG `feColorMatrix`（只在 Chromium GPU 合成下需要，WebKit 的 2D canvas 自己转换）。I420 的 YUV → RGB 矩阵按 BT.601 / BT.709 与 limited / full range 由 Kr、Kb 计算，`I420Frame` 增加 `fullRange`、`primaries`。
  - **e2e**：`e2e/surfaces.spec.ts` 删掉颜色映射拟合与放宽的平均差上限，三种 Surface 直接逐像素比较（平均差 < 6，差值 > 40 的像素 < 3%）。
- 目标：Edge 与 WebKit 上画面面与 `<video>` 的色差回到 e2e 原阈值（平均差 < 6，差值 > 40 的像素 < 3%），删掉 `e2e/surfaces.spec.ts` 里的颜色映射拟合。
- 只做 SDR；HDR（PQ / HLG、色调映射）不做。

### 5. 多编码探测与偏好持久化（第三批第一项，2026-10-25）

- **探测**：每次加载对 AV1 / HEVC / VP9 / H.264 各跑一次 `MediaCapabilities.decodingInfo`（同时要求 `isTypeSupported`），每个编码族一条 `router.explain()`（supported、smooth、powerEfficient、名次）。
- **排序**：宿主可配（`MediaPluginOptions.codecs { order, rank }`），默认先 powerEfficient、再 smooth、再 AV1 > HEVC > VP9 > H.264；用户偏好（`set-codec-preference`，`state.codecPreference`）排在宿主规则之前。排序逻辑是按需块（0.88 KB），与能力探测并行加载。
- **引擎**：`EngineContext.codecs { order, entries, pick }`，引擎在流提供的编码族里只保留排名最高的一族（不做跨编码切档，SPEC §6.2），这一选择也进 `router.explain()` 和 `state.codec`。自研 HLS 引擎过滤 variant；hls.js 在 `MANIFEST_PARSED` 后、开始加载前 `removeLevel`；Shaka 在 TXml 预处理里删掉 MPD 中其他编码族的视频 Representation，并设 `preferredVideo`（Shaka 播 HLS 时）。
- **平台虚报**：CI 的 Mac 上 WebKit 说 AV1 supported、smooth、powerEfficient，实际解不出画面。首帧之前出现致命错误（加载被拒或启动卡住），且流里还有别的编码族时，本次加载剔除该族，同一后端重新加载下一族，`router.explain()` 记「no picture (…) although decodingInfo said supported; next family」。
- **编码族剔除（2026-10-26 负责人确认，接受为第 1 项的一部分）**：剔除的编码族进 `state.codecExcluded`（编码族 → 原因），同一页面之后的加载不再尝试；`@otter-player/preferences` 把它按「编码族 + UA」单独存一个 key（`codec-failures`，与用户偏好分开），30 天过期，下次访问起播前就排除（`exclude-codecs`），`router.explain()` 记「excluded: no picture on this device on <日期>, remembered until <日期>」。同一设备上这 3 s 左右的代价只付一次。不在 WebKit 上默认把 AV1 排到后面（M3 起的 Mac 能解 AV1）。
- **偏好持久化**：新包 `@otter-player/preferences`，`createPreferencesPlugin({ storage?, key? })`。
  - 存储适配器可替换（`get` / `set`，同步或异步）；默认 `localStoragePreferences('otter:')`，导入时不碰任何全局（SSR 安全），只在读写时访问 `localStorage`，抛错时静默。
  - 只存：编码偏好、清晰度（存画面高度，换片源也适用）、音轨语言、字幕语言（含「关」）、音量、倍速；不存播放位置。读出时逐项校验，非法值丢弃。
  - 只记录用户动作（ABR 切档、长按 2 倍速、直播追帧不算）；音量、倍速、编码偏好在启动时恢复（编码偏好从下一次加载生效），清晰度和语言在每个片源的轨道就绪后恢复一次。

### 4. M4 收尾

- **WHEP**：以本地夹具（视频 + Opus 音轨）为验收依据；另在真机 Edge 上手动播一次、人耳确认有声，一句话记进 M4 报告。
- **CI WebKit 的 `hwfail` 用例**：保持 `test.fixme`，M7 有 Mac 时再查。
- **CI Chrome 后台模式偶发**（回到前台后 5 s 内画面没追上时钟，ee61a75）：
  - **记录**：用例改为记录回到前台后画面实际追上时钟的耗时，每次 CI 上传为 artifact；断言放宽到 15 s，只拦住真正追不上的情况。
  - **再定**：main 上积累 20 次运行后汇总分布，再定阈值或修复。

## 代价

- DVR 跨两批：首批只有状态与可拖范围，界面要等第二批；这期间直播时间条仍不可拖。
- 色彩管理只做 SDR：HDR 内容在画面面上仍按 SDR 显示。
- 后台模式用例在得出分布之前门槛较宽（15 s）。
