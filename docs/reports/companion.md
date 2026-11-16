# 伴随模式（companion mode）报告

- 状态：第 0–3 停已交付，**提请负责人目视验收**；验收第 2 条在 CI 上不稳定（见第 2 节），Firefox 有 Document PiP 待定（见第 5 节）
- 关联：需求 `docs/design/COMPANION.md`；契约 ADR-016；实测 RESEARCH §1「伴随模式第 0 停」与「真 Edge 补量」；SPEC §15.1
- 基线：`624518a`；全部提交直接在 main
- 日期：2026-11-11 至 2026-11-16（负责人 2026-11-16 对四个问题的答复已落实，见第 5 节）

## 1. 提交与 CI

| 提交 | 内容 | CI |
|---|---|---|
| `5c312bb` | 第 0 停：需求归档、ADR-016 提议、SPEC §15.1、GLOSSARY、RESEARCH 实测、探针 | #287 红：e2e chromium + firefox 的 `playwright install` 一步退出码 1，后续步骤没有浏览器（基础设施，同代码的夜间 #289 绿） |
| `e3596a4` | 内部文件 `companions.ts` 改名 `helpers.ts` | 与下一行同一次推送 |
| `e1da063` | ADR-016 采纳（各冲突取建议项） | #288 红：同 #287 |
| `aa8cb23` | 第 1 停：状态与动作、暗化、三档尺寸、偏好、悬停精简栏 | #290 被夜间 #291 取消（同一并发组）；#291 跑同一代码，全绿 |
| `97e87f7` | 修复：PiP 小窗里的节点属于小窗的 realm，`instanceof` 失效（菜单、语言、按键） | 与下一行同一次推送 |
| `1119ccf` | 修复：PiP 文档没有 title / lang（axe serious） | 同上 |
| `a2d3575` | 第 2 停：音频条、quiet、关窗、设置页 | #293 全绿 |
| `8be4d59` | 真 Edge 补量（文档） | #295 绿（只改文档，e2e 按规则跳过） |
| `a1c2547` | 第 3 停：退化与 WebCodecs 用例、`@example`、文档站一页、changeset | #296 全绿 |
| `80ba439` | 修复：≤ 300 px 宽的小窗里精简栏折成两行；目视材料探针 | #297 红：e2e chromium + firefox 里伴随的 WebCodecs 用例两次尝试都有音频欠载（见验收第 2 条）；webkit 另有两条与本任务无关的用例重试通过 |
| `7c498ea` | 本报告初版与目视材料 | #298 绿（只改文档） |
| `ec4c8a8` | 修复：普通 docpip 下播放器铺满小窗 | 与下两行同一次推送 |
| `401e033` | 修复：≤ 300 px 宽的小窗里设置页的分段折行 | 同上 |
| `5cd8398` | 测试：`OTTER_COMPANION_JUDGE` 可以加判定项目 | #299 绿；伴随的 WebCodecs 用例第一次尝试欠载 512 ms、重试通过（flaky） |
| 本次更新 | Firefox 事实、WebCodecs 用例的诊断输出、重截的目视材料 | 见汇报 |

Pages 自 `624518a` 起每次都红（第 13–17 次）：ADR-015 的冻结检查要求 `packages/` 与 `56893d2` 相同，任何包改动都会被拦下。这不是本任务引入的，未处理（约束：不动公开站的构建）。

## 2. 验收逐条

判定项目：desktop-chrome（CI 与本机）和真 Edge。真 Edge 用的是负责人局域网里的 Windows 机器（见第 4 节），不是任务指定的云实例。

| # | 验收 | 结果 | 依据 |
|---|---|---|---|
| 1 | 暗化：小窗内计算不透明度 = 设置值，回页面 = `1 - brightness`；像素核对 | ✅ | `e2e/companion.spec.ts`。计算值：小窗 0.4，回页面 0。像素比（小窗 / 页面）在暗化 0 / 0.4 / 0.8 时：desktop-chrome 0.999 / 0.600 / 0.200，真 Edge 0.996 / 0.598 / 0.199 |
| 2 | 进出不断播（跳变 ≤ 0.5 s）；WebCodecs 进出无音频欠载 | ⚠️ CI 上不稳定 | 播放头：每 50 ms 采样，进出全程不停、不回跳、相邻样本不超过墙钟 + 0.5 s。WebCodecs（`player.html?companion=1`，有声片源）：本机 desktop-chrome、真 Edge、Firefox 160 都没有欠载（46–55 个样本）。**CI 的 desktop-chrome 上 5 次尝试有 3 次欠载**：#296 过；#297 两次都欠载（6 ms + 1587 ms，401 ms）；#299 第一次欠载 512 ms、重试过。欠载时解码队列都在上限（17），与 M6 F14 的签名一样；F14 的放过规则只适用于 emulated-android，这里照样判红。原因未查。假设：小窗拿到焦点时，原页面的定时器（喂音频的循环跑在上面）被节流。待 CI 数据验证：用例失败时会打印原页面 50 ms 定时器的最大间隔和长任务 |
| 3 | 刷新后 dim / size / audioOnly 恢复；进出一次后 textLanguage 与 danmaku 逐字节相同 | ✅ | e2e：刷新后恢复 0.6 / l / true；进出前后两字段的 JSON 相同。另一条 e2e：quiet 关掉、再恢复字幕，textLanguage 不变。弹幕的 quiet 由单测覆盖（vod 页面没有弹幕插件） |
| 4 | 退出后恢复原状 | ✅ | 字幕回到进入前的轨（e2e）；弹幕回到进入前（单测）；控件 3 s 后重新自动隐藏；`documentPictureInPicture.window` 为空；页面里没有 `style[data-otter-companion-style]`、`[data-otter-companion]`、占位节点；destroy 后所有 MediaSource 为 closed |
| 5 | 指针不在小窗内播放 5 s 控件不可见；进入可见；键盘可到达全部控件 | ✅ | e2e：每 0.5 s 查一次，共 10 次都不可见；指针进入后可见，停留 3.5 s 仍可见；移出即隐藏；Tab 依次到达播放、静音、进度、设置、回页面，到达时控件可见，被隐藏的按钮到达不了 |
| 6 | desktop-firefox、desktop-safari、emulated-iphone：`supported` 为 false，`toggle-pip` 走视频 PiP 或既有规则，没有错误事件 | Safari / iPhone ✅；**Firefox 与前提不符，待定** | e2e「without Document PiP」：Safari 与 iPhone 本来没有这个 API，WebKit 拒绝打开视频 PiP 窗口，已回滚并发 `presentation-denied`，没有 error 事件；iframe 内 `supported` 为 false。**Firefox 有 Document PiP**：正式版 Firefox 160 和 Playwright 自带的 Firefox 157 都提供（在负责人的 Windows 机器上实测，第 4 节），所以 desktop-firefox 上 `supported` 为 true。两者跑伴随用例各 14 条全过。去掉 API 后的退化用例在所有项目上都跑、都过 |
| 7 | 首屏 ≤ 30 KB 不变并报余量；伴随按需块单列 | ✅ | 首屏 27.00 / 30 KB（基线 26.49，余量 3.00 KB）。伴随按需块（presentation `companion` + presets `companion-style`）1.76 / 3 KB，`.size-limit.js` 单列 |
| 8 | 只在 desktop-chrome 与真 Edge 判定；emulated-android 只记录 | ✅ | 两处各 14 条全过。其他项目跳过并留通知（`supported=…`），只判退化用例 |
| 9 | 目视材料：三档尺寸、音频条、暗化 0 / 40 / 80 %、最小档设置页，中英文各一组 | 提请验收 | 第 3 节 |

## 3. 目视材料（真 Edge 157，`80ba439`）

截图是小窗的内容区，不含浏览器标题栏；屏幕缩放 150 %，所以图片像素是窗口尺寸的 1.5 倍。用 `e2e/probes/companion-visuals.probe.ts` 生成，可以重跑。三档尺寸那几张是指针在小窗里（控件显示）时截的；暗化那几张是暂停在同一帧、指针在外面（控件隐藏）。

| 项 | English | 中文 | 小窗内容区（px） |
|---|---|---|---|
| 尺寸 s | ![](companion/en-size-s.png) | ![](companion/zh-CN-size-s.png) | 248×135（Edge 最窄 248） |
| 尺寸 m | ![](companion/en-size-m.png) | ![](companion/zh-CN-size-m.png) | 320×180 |
| 尺寸 l | ![](companion/en-size-l.png) | ![](companion/zh-CN-size-l.png) | 441×248 |
| 音频条（m） | ![](companion/en-audio-strip.png) | ![](companion/zh-CN-audio-strip.png) | 321×66 |
| 暗化 0 % | ![](companion/en-dim-0.png) | ![](companion/zh-CN-dim-0.png) | 320×180 |
| 暗化 40 % | ![](companion/en-dim-40.png) | ![](companion/zh-CN-dim-40.png) | 同上（±2） |
| 暗化 80 % | ![](companion/en-dim-80.png) | ![](companion/zh-CN-dim-80.png) | 同上（±2） |
| 最小档的设置页 | ![](companion/en-settings-s.png) | ![](companion/zh-CN-settings-s.png) | 248×135 |

截图用的是 `5cd8398`，含下面两处修复。请重点看：

- 最小档（s）的精简栏。第一轮截图里，5 个控件在 248 px 宽时折成了两行，挡住大半画面。`80ba439` 修了：窗口宽 ≤ 300 px 时按钮改为 32 px。
- 最小档的设置页。它在窗口里铺成一层面板，四周留 8 px，可以滚动。第一轮里「80 %」那一格折到了第二行，`401e033` 修了：窄窗口里分段间距收紧，五档在一行。
- 音频条上没有设置按钮（需求第 5 条的列表里没有它）。要关掉音频条，回到页面后在设置里改。

## 4. 真机

- **云实例** `inst-01m4skyh174y47p9n6yhxdy7at`：没有连上。工作副本是新 clone 的，`tmp/env`、`tmp/win.py` 都不存在。按要求没有另建实例。
- **负责人改为提供局域网 Windows 机器**（192.168.1.2）：
  - 硬件：Windows 11 专业版，i5-13500H，Intel Iris Xe（另有 MuMu 虚拟显示适配器），内存 15.7 GB，2560×1600 屏、缩放 150 %。
  - 浏览器：Edge 157.0.4341.46。Playwright 的 Desktop Edge 设备描述会把 UA 改成 156。
  - 做法：通过那台机器上的 go-agent-platform `vm-agent`（7070 端口）远程执行命令；仓库 clone 在那台机器上，测试站跑在它的 `localhost`。
  - vm-agent 两次被换成新版本并重启：2026-11-15 13:28 左右（`0.1.0-dev+remote.2`）和 2026-11-16 05:20 左右（`remote.3`）。这都不是本任务的操作。每次重启都停掉了正在跑的测试站服务，重新启动后继续。
- **Firefox**（同一台机器，2026-11-16，负责人要求实际去看）：
  - 正式版 Firefox 160.0：从 download.mozilla.org 下载，签名有效，解包运行，没有装进系统。
  - Playwright 自带的 Firefox 157：即 CI `desktop-firefox` 用的那个构建。
  - 两者都有 `documentPictureInPicture`。正式版在不经 Playwright、新 profile 下也确认了一次。
  - 伴随 e2e 各 14 条全过。正式版的暗化像素比 1.004 / 0.590 / 0.189。
  - 测试工具在 Firefox 的 PiP 窗口上有几处限制（BiDi 不能把指针移出视口；`page.close()` 卡住；关 context 报错），用例已绕开，见 RESEARCH §1。
- **真 Edge 上的结果**：
  - 第 0 停的六项全部补量，见 RESEARCH §1「真 Edge 补量」。
  - `e2e/companion.spec.ts` 在 `80ba439` 上 14 条全过：第 1–2 停的 11 条，加上 WebCodecs、退化、iframe 三条。
  - 截图时还看到一个现象：同一尺寸反复打开，Edge 恢复上次的窗口尺寸时有约 1 px 的累积取整误差（320 → 321 → 322）。只记录，不处理。

## 5. 与需求的偏离、未完成项

1. **ADR-016 采纳方式**：负责人回复「那你就继续做呗」后，按 ADR 写的建议项执行；批准记录在 ADR 末尾。
2. **「回到页面」不改变播放状态**：在播的继续播，暂停的保持暂停。负责人 2026-11-16 确认。
3. **「省 CPU」的写法**：Chromium 与真 Edge 结论一致，按 ADR-016 冲突 7 (a)，文档（文档站一页）写的是「隐藏画面后合成与上屏的 CPU 下降，解码不变」，没有写「省电」或笼统的「省 CPU / GPU」。
4. **切走标签页自动进小窗**（只量不做）：Chromium 156 和 Edge 157 都接受 `enterpictureinpicture` 这个动作，但真实切换标签页后都没有调用。需要什么条件没有查到。
5. **Firefox 有 Document PiP**（验收第 6 条的前提不成立）：按特性探测，伴随模式在 Firefox 上可用，实测正常。是否把 Firefox 列进判定项目，见 ADR-016 末节，待负责人定。
6. **本机 e2e 的环境问题**：本机 desktop-chrome 上，5 个文档示例和 basic preset 偶尔停在 0.2–0.3 s。在 HEAD 上不带本任务改动也一样；CI 上通过。原因没查。
7. **普通 docpip 铺不满小窗**：负责人 2026-11-16 要求修，`ec4c8a8` 已修。新的 e2e 用例在旧代码上失败（播放器在小窗里偏移 16 px）。
8. **验收第 2 条在 CI 上不稳定**：见第 2 节，原因未查，诊断已加进用例。

## 6. 文件

- 产品代码：
  - `packages/presentation/src/companion.ts`（按需块）
  - `packages/presentation/src/plugin.ts`、`controller.ts`、`docpip.ts`
  - `packages/ui-core/src/player-ui.ts`、`elements.ts`、`settings-level.ts`、`strings.ts`
  - `packages/preferences/src/index.ts`
  - `packages/presets/src/companion-style.ts`（按需块）、`player.ts`、`basic.ts`、`tv.ts`
  - `packages/input/src/controller.ts`
- 测试：
  - 单测：`packages/presentation/test/companion.test.ts`、`packages/ui-core/test/companion.test.ts`、`packages/ui-core/test/realm.test.ts`、`packages/preferences/test/preferences.test.ts`、`packages/input/test/controller.test.ts`
  - e2e：`e2e/companion.spec.ts`
  - 探针：`e2e/probes/companion.probe.ts`、`e2e/probes/companion-visuals.probe.ts`
- 示例与文档：
  - `e2e/site/companion.html`、`e2e/site/examples/companion.ts`
  - `docs-site/guides/companion.md`
  - `.changeset/pre/companion-mode.md`、`.changeset/pre/docpip-window-fixes.md`
