# 伴随模式（companion mode）需求归档

- 日期：2026-11-11（归档）；需求提出：2026-10-29（负责人看 demo 后口头提出，此前没有写进仓库的任何文档）
- 状态：需求已定；契约见 ADR-016（2026-11-11 采纳）
- 排期：beta.0 首发之后插入，排在 M7 真机回归之前，随下一个 beta 发布
- 基线：`main` 的 `624518a`
- 关联：SPEC §15「伴随模式」；ADR-007 §5（presentation 状态机、Document PiP）；RESEARCH §1「伴随模式第 0 停」；`docs/design/GLOSSARY.md`

## 1. 要解决的问题

一边工作一边播放，不打扰主任务。用户把播放器放进一个置顶的小窗：

- 画面可以调暗；
- 控件平时不出现；
- 也可以只留一条音频条。

## 2. 硬边界

浏览器的两种画中画都做不到**窗口透明**和**点击穿透**，原生视频 PiP 和 Document PiP 都一样。只有桌面壳（Electron / Tauri 之类）能做，那是另一个项目，本任务不碰。

## 3. 需求

1. **建在 Document PiP 上**：伴随 = 现有的 `docpip` 模式，加一份伴随状态 `presentation.companion`。不新增 `PresentationMode`，SPEC §15 的状态图不变。
2. **默认关闭**：
   - 宿主用 `presentation.companion: true | CompanionOptions` 开启。
   - 开启后，在有 Document PiP 的浏览器上，`toggle-pip` 进伴随小窗。
   - 另加两个动作：`toggle-companion`；`companion-set`（改暗化、尺寸、纯音频条，立即生效）。
3. **暗化**：
   - 复用 ui-core 现有的暗化层（`<otter-gesture>` 里的 `.dim`），不加第二层，不碰 surface 的滤镜链。
   - 层的不透明度取 `max(1 - brightness, dim)`。伴随不改 `brightness` 状态。
   - 只在小窗内生效，回到页面立即恢复。
   - 只暗化画面层，弹幕、水印、字幕、控件不受影响。
4. **小窗内的控件**：
   - 播放开始、媒体事件都不触发显示。
   - 只有指针进入小窗，或键盘焦点落在控件上，才显示；离开即隐藏。
   - 控制栏精简为：播放 / 暂停、静音、进度与时间、设置、回页面。
5. **纯音频条**：
   - 画面层不显示，窗口缩到条高。
   - 条上常显：播放 / 暂停、静音、进度与时间、回页面。
   - 本期只做界面，不停视频解码。
6. **quiet**：
   - 进入小窗时关弹幕和字幕，退出时恢复进入前的状态。这次关闭不写偏好。
   - 用户在小窗里手动打开的，只在本次小窗内有效。
7. **关窗**：
   - 用户关掉小窗时，按 `onClose` 处理：`'pause'` 暂停，`'continue'` 回到页面继续播。
   - 小窗内自己的「回页面」按钮：退出小窗、继续播放、尽力聚焦原标签页。
8. **偏好**：
   - `Preferences` 加 `companion` 字段，存 dim、size、audioOnly，`sanitize` 夹取范围。
   - 不存窗口位置。
9. **设置菜单**：
   - 加一页，中文「小窗」，英文待术语表定。
   - 内容：暗化五档（0 / 20 / 40 / 60 / 80 %）、尺寸三档、纯音频条开关。
   - 宿主开启伴随且浏览器支持时才出现。页面内和小窗内都能调。
10. **退化**：
    - 没有 Document PiP 的浏览器（Firefox、Safari、iPhone）和 iframe 内：`toggle-pip` 照旧走原生视频 PiP，只有画面。
    - `presentation.companion.supported` 为 false，设置页不出现，不报错。
11. **媒体键**：现有的 MediaSession 绑定在小窗内必须继续有效。
12. **适用范围**：经 `createPlayer` 的 preset。basic、tv、shorts、surveillance 不提供；每个 preset 的结论见 ADR-016。
13. **命名**：
    - 公开术语用 companion。
    - 现有内部文件 `presentation/src/companions.ts`，以及 `PresentationPlugin.ready` 的 TSDoc 里的 companions，改名（建议 helpers）。不改任何公开标识符。
    - GLOSSARY 两个词都加。
14. **体积**：
    - 首屏门禁（ui-skin-default + ui-core + presentation + text ≤ 30 KB）不动。
    - 伴随的代码和样式放进按需块，样式只注入小窗文档。
    - 按需块单列，暂定 ≤ 3 KB gzip；超了先报数，由负责人定。

## 4. 契约初稿（负责人 2026-11-11，ADR-016 以此为底）

```ts
interface CompanionOptions {
  /** 画面暗化，0 到 0.8。默认 0.4。 */
  dim?: number;
  /** 小窗宽度档位：240 / 320 / 440 px，高度按画面宽高比算。默认 'm'。 */
  size?: 's' | 'm' | 'l';
  /** 纯音频条：不显示画面，窗口缩成一条。默认 false。 */
  audioOnly?: boolean;
  /** 进入小窗时关掉弹幕和字幕。默认 true。 */
  quiet?: boolean;
  /** 用户关掉小窗时：暂停，或回到页面继续播。默认 'pause'。 */
  onClose?: 'pause' | 'continue';
  /** dim、size、audioOnly 是否记进偏好。默认 true。 */
  remember?: boolean;
}
```

第 0 停的实测与初稿冲突的地方，逐条列在 ADR-016「与初稿的冲突」，待负责人定。

## 5. 分停

| 停 | 内容 |
|---|---|
| 0 | 只量、只写文档：RESEARCH §1 的六项实测；本文件、ADR-016、SPEC §15 增补、GLOSSARY |
| 1 | `presentation.companion` 状态与三个动作；暗化；三档尺寸；偏好读写；小窗内的精简控制栏与悬停显示；示例站 `e2e/site/companion.html` |
| 2 | 纯音频条；quiet 的关闭与恢复；`onClose` 与「回页面」按钮；设置菜单的小窗页；中英文文案；小窗文档的 axe 检查 |
| 3 | 退化路径；TSDoc 与 `@example`（取自 `e2e/site/examples`）；文档站一页；changeset；真 Edge 复核；报告 `docs/reports/companion.md`，提请目视验收 |

ADR-016 批准之前不写产品代码。

## 6. 验收（负责人 2026-11-11）

1. **暗化**：小窗内暗化层的计算不透明度等于设置值，回到页面后等于 `1 - brightness`。能截到小窗的话，再按像素核对画面亮度比。
2. **进出小窗不断播**：
   - `currentTime` 跳变 ≤ 0.5 s；
   - WebCodecs 路径在 desktop-chrome 上进出期间无音频欠载。
3. **偏好**：
   - 刷新后 dim、size、audioOnly 恢复；
   - 进出一次小窗后，偏好里的 textLanguage 和 danmaku 与进入前逐字节相同。
4. **退出后恢复原状**：
   - 弹幕与字幕回到进入前的状态；
   - 控件自动隐藏回到 `idleMs`；
   - 小窗关闭，页面里没有残留节点和样式；
   - destroy 后 MediaSource 为 0。
5. **悬停**：
   - 指针不在小窗内时播放 5 s，控件始终不可见；
   - 指针进入后可见；
   - 全部控件可用键盘到达。
6. **退化**：desktop-firefox、desktop-safari、emulated-iphone 上 `supported` 为 false，`toggle-pip` 进原生视频 PiP 或按既有规则跳过，没有错误事件。
7. **体积**：首屏 ≤ 30 KB 不变，并报出余量；伴随按需块单列。
8. **判定项目**：
   - 伴随功能只在 desktop-chrome 和真 Edge 上判定。
   - emulated-android 上的 Document PiP 是已标记的 flaky，只记录不判定。
   - 其余项目只判退化路径。
9. **目视验收材料**：三档尺寸、音频条、暗化 0 / 40 / 80 %、最小档下打开设置页，中英文各一组截图。

## 7. 明确不做

- 窗口透明、点击穿透、桌面壳。
- 切走标签页自动进小窗（MediaSession `enterpictureinpicture`）：第 0 停只量。
- 纯音频条下真正停掉视频解码：第 0 停只量。
- 「听」模式、静音跳过、切会议或拔耳机自动暂停、稍后看书签。
- 手机和电视上的伴随模式。
- 存小窗的位置。

## 8. 约束（负责人 2026-11-11）

- 不新增依赖；确实需要，先问负责人。
- 不发布、不打 tag、不跑发布工作流；只加 changeset。
- 不动 `site-assets/` 里冻结的浏览器产物，不动公开站的构建（ADR-015）。
- TSDoc 和文档站用英文，并过门禁；ADR、SPEC、RESEARCH、报告用中文。
- 文档里不写「省 CPU / GPU」，除非第 0 停量出来成立。第 0 停的数字见 RESEARCH §1，结论待负责人定（ADR-016 冲突 7）。
