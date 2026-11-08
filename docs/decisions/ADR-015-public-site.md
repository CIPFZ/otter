# ADR-015：公开站独立于 npm 首发

- 状态：已采纳
- 日期：2026-11-08
- 关联：ADR-014 §3、§4a、§6、§7；负责人本次发布指示

## 背景

负责人决定暂缓 npm 首发收尾，先上线文档站、在线演示和可下载浏览器产物。npm 已上传的包与可信发布登记并未全部完成；网站上线不能被表述为 npm 首发完成。

## 决定

- 通过现有 Pages 工作流部署到 https://cipfz.github.io/otter/，保留 `PAGES_ENABLED` 部署开关。此工作流不发布 npm、不创建或推送 tag、不登记可信发布。
- 文档继续从源码生成，并通过原有 TSDoc 门禁；只在公开站模式增加 Demo / Downloads 导航与 npm 未完成提示，不改变本地示例站的入口。
- `scripts/build-public-site.ts` 消费一次 workspace build 的 `packages/cdn/dist`，不重建播放器。全量复制为 `browser/0.1.0-beta.0/`，包括 basic / vod 入口、CSS、按需 chunks 和构建输入清单。
- 浏览器代码仍来自冻结点 `56893d2dd70f370be4e1828f4753f560e9ecc804`。组装前检查包源码、依赖锁定和构建输入与该点相同；站点提交不改变包版本、结构或构建参数，也不能取代最终 npm tag 所指的冻结点。下一版需显式更新版本与来源记录。
- `downloads/otter-browser-0.1.0-beta.0.zip` 包含浏览器目录全部文件，同一个版本前缀下保留相对路径。附 CDN 原有 LICENSE 和完整 NOTICE（含第三方许可全文）、英文 README、逐文件 SHA256SUMS，并另提供 ZIP SHA-256 和下载大小。
- ZIP 用 Node 内置模块写 store 格式（UTF-8 名称、CRC-32、固定日期、排序文件），可在 Windows / Linux 生成，无新增依赖或全局工具。
- 在线 demo 用同站浏览器 ESM/CSS，并复制现有 `e2e/media/vod/progressive.mp4` 为 `demo/media/sample.mp4`。这是 `generate.sh` 的纯 testsrc2 / sine 合成样例；附来源说明与仓库 Apache-2.0 许可，不请求外网样例。
- 部署前运行 `node scripts/check-public-site.ts --browser`：校验本地链接、相对 ESM 依赖、许可、逐文件校验和、ZIP 与托管目录的一致性，并在 `/otter/` 项目路径下验收播放。验收失败不上传或部署。

## 后果

网页与浏览器 ZIP 可以独立使用；npm registry 状态及可信发布登记仍由首发流程单独验收。网页不再要求用户安装 npm 才能体验，但仍明确 beta、浏览器基线和按需 chunks 不能丢弃。版本目录的播放器输入保持冻结，未来站点文案更新不能静默替换同一版本的播放器代码。
