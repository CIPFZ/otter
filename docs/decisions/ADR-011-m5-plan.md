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

### 3. 画布 SDR 色彩管理（第二批）

- GPUSurface 与 CanvasSurface 按 `VideoFrame.colorSpace` 在 shader 里做 BT.601 / BT.709 矩阵与 limited / full range 到 sRGB 的转换。I420 帧（WASM 解码）按解码器报告的色彩信息；未标注时按分辨率推定（SD 用 601，HD 用 709），与浏览器对 `<video>` 的默认一致。
- 目标：Edge 与 WebKit 上画面面与 `<video>` 的色差回到 e2e 原阈值（平均差 < 6，差值 > 40 的像素 < 3%），删掉 `e2e/surfaces.spec.ts` 里的颜色映射拟合。
- 只做 SDR；HDR（PQ / HLG、色调映射）不做。

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
