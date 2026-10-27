# ADR-013：M6 批次与范围（presets、绑定、SSR、文档站、体积收口）

- 状态：已采纳
- 日期：2026-10-27
- 关联：`SPEC.md` §1.1、§19、§21、§23 Q1；ADR-004（体积口径）、ADR-010 §3（自研 HLS 引擎体积）、ADR-012（弹幕）；`docs/reports/M5.md`「M5 → M6 交接」

## 背景

M5 于 2026-10-27 关闭。负责人按「M5 → M6 交接」定了 M6 的四批顺序和 Q1。M6 的验收（SPEC §21）是两条：体积预算全部达标（含 Hero < 5 KB），以及文档站上线。

## 决定

### 1. Q1 结案

- 名称 Otter 不改，npm scope `@otter-player/*` 不改。
- 改名清单（交接 §8）只备案，不执行。
- 发布前仍要核验这个 scope 在 npm 上是否被占用。

### 2. 批次（每批一到三项一停，四段汇报，报告 `docs/reports/M6.md`）

| 批 | 内容 | 依据 |
|---|---|---|
| 一 | **core 三样补丁**：服务端快照（`getInitialState` / server snapshot）、监听隔离（一个监听抛错不打断 `setState` 与其他监听）、`destroy` 清掉 store 的监听。**自研 HLS 全部块压回 15 KB**：先把门禁改成 15 KB，再按交接 §3 的候选 1–3 动代码：SPF 解析器去掉交给 hls.js 的分支、EWMA 换成双 EWMA 函数、mse-sink 的账本与 `abort()` 拆成按需块 | 交接 §3、§6；ADR-010 §3 |
| 二 | **Hero preset**：按交接 §2 的拆法（store + `observeMediaElement`，不走会话），≤ 5 KB 进门禁。**`createPlayer` 与九个 preset**：vod、live、lowlatency、ott-drm、surveillance、danmaku、shorts、tv、background，每个 preset 对应一个 §19 场景的体积条目 | 交接 §1、§2、§4 |
| 三 | **React / Vue / Svelte 绑定**：只依赖 `getState` / `subscribe` / `dispatch`。**SSR**：52 个入口导入安全保持不变；三处调用时碰 window 的地方加守卫（imsc 的 TTML 路径、Shaka / mpegts.js 引擎的创建、不传 registry 的 `defineElements()`）；`check-side-effects` 补上顶层 `class extends`（DOM 类）和 sub-path 入口的检查 | 交接 §5、§6 |
| 四 | **`ui-skin-tv` 与遥控器输入**（焦点管理、方向键映射）；**shorts preset 的竖屏手势**；**文档站**：按交接 §7 的 API 面从源码自动生成 | 交接 §4、§7 |

- SPEC §21 的「多宫格每路独立记住放大与滤镜」不在以上四批里，等四批完成后与负责人确认放在哪一批。

### 3. 体积口径

- 自研 HLS 引擎全部块从 16.5 KB 回到 15 KB，第一批第一步就改门禁，ADR-010 §3 随之修订。
- Hero 从 M6 第二批起进门禁（≤ 5 KB），不再只报告。
- §19 的「含引擎」列随 preset 定稿改口径：默认引擎是自研的（HLS、FLV / TS），按自研块计；第三方引擎单列为回退或不支持的流。

## 代价

- 体积收口要动 SPF 的 L3 拷贝（候选 1）。本地改动变多，UPSTREAM.json 要记清楚，以后同步上游时要合并。
- EWMA 换掉后，hls.js 的 `ewma.ts` 从 L3 改为 L4（只借设计，REUSE 改记录）。
