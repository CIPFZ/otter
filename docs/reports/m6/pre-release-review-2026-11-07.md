# 0.1.0-beta.0 首发前审查（2026-11-07）

## 范围与基线

基线：8330be18483e069d62a9799fcacb1699f3b4007f。负责人要求在首次公开发布前复查，并授权修复、提交、推送后继续发布。本轮覆盖自有播放生命周期、直播缓冲、格式适配、组件绑定、UI/Presentation、首发与后续 staged release 工具、CDN 冒烟服务器。使用源码跟踪、旧代码对照复现、针对性回归和完整仓库门禁验证；未发布 npm 包或推送版本标签。

首次发布仍使用尚未公开的 0.1.0-beta.0；本轮不新建版本。先前冻结点因负责人明确授权修复而更新，发布标签应统一指向最终通过 CI 的修复提交。

## 已确认的问题与修复

| # | 触发或影响 | 修复与回归位置 |
| --- | --- | --- |
| 1 | 直播订阅者长期暂停或后台停读时历史包持续积累；只按时间约束不能覆盖重复时间戳 | media/live-demux 共享历史与游标，每轨 15 秒、64 MiB、8192 包独立上限，恢复时从关键帧同步音视频；live-demux.test |
| 2 | WebCodecs 非 1 倍速静音分支不回收过期 PCM | audio 回收先于倍速分支；audio-worklet.test |
| 3 | Native 销毁后旧 loadedmetadata/error 回调仍可修改新播放状态 | 中止与监听清理；native.test |
| 4 | 同一次 load 同时触发 fatal 事件与 Promise 拒绝，重复恢复会破坏新后端 | session 统一失败归属并核对活动后端；session.test |
| 5 | WebCodecs 异步 supports/setup 在销毁后完成，创建遗留音频和渲染资源 | await 后检查销毁状态并释放资源；backend.test |
| 6 | pipeline 后端加载在销毁后完成，继续设置轨道、速率和播放 | fallback 生命周期检查；fallback.test |
| 7 | SourceBuffer error 后紧接 updateend，错误队列项被弹出两次 | error 拒绝当前操作，队列占有持续到 updateend；mse-sink.test |
| 8 | core 插件安装进行中销毁，包括同步 install 内重入 destroy，产生晚到插件泄漏 | 安装/卸载屏障与代次检查；core.test |
| 9 | mediabunny 打开期间取消，不会及时释放 Input | 绑定 abort 与 Input.dispose，保留 AbortError；hls-cancel.test |
| 10 | HLS 刷新重试耗尽后 fatal 错误被吞掉 | 向会话报告并停止刷新；live-errors.test |
| 11 | WS/WSS FLV 的 MSE 路径误走 fetch 管线 | 使用已有 mpegts 适配器处理 WebSocket；engine.test |
| 12 | Shaka 延迟 destroy 清理共享 video，覆盖新 Native/MSE 源 | media 共享 detach 屏障；detach.test、shaka.test |
| 13 | React selector/comparator 变更后仍使用旧缓存 | selector/comparator 纳入缓存身份；react.test |
| 14 | React/Vue 卸载未稳定通知 onPlayer(null) | 绑定清理与同步通知；react.test、vue.test |
| 15 | 同一容器重新初始化后控件仍引用旧 store；未等待旧 destroy 时复用旧 shell | store 重新连接，拥有的 shell 同步移除，保留宿主节点；m2-elements.test、presets.test |
| 16 | 公开 Player.load 提前 resolve，无法等待 canplay 或捕获格式/加载失败 | 关联对应 load action 的 Promise，取消/替换返回 AbortError，保留 action 可观察性；load.test、session.test |
| 17 | preset/surveillance 销毁遗漏 VideoSurface 观察器 | 由创建者清理 surface；presets.test |
| 18 | 全屏/PiP/Document PiP 请求晚于销毁完成，遗留窗口/滚动锁或退出新实例模式 | 生命周期与容器所有者检查；presentation/plugin.test |
| 19 | 弹幕 WebM mask 或异步加载在销毁后遗留 | mask 清理与加载代次检查；lifetime.test |
| 20 | Menu 重挂载重复增加 document pointerdown 监听 | connected/disconnected 对称注册；m2-elements.test |
| 21 | TV MediaPlay/MediaPause 都切换播放状态，重复按键会反转意图 | 分别派发绝对 play/pause；remote.test |
| 22 | 首发预先接收 OTP，构建预演耗时使验证码在使用前过期；重定向输出还会阻断 npm 交互认证 | 拒绝早传 OTP，正式发布要求真实 stdin/stdout，实际 npm 提示时输入；publish-input、first-publish、terminal-capture、interactive-command 测试 |
| 23 | Release 工作流在新克隆构建前审计 CDN，缺少 dist/inputs.json | 构建先于许可审计和 dry-run；release.yml 名称保持不变 |
| 24 | CDN 冒烟服务器绑定所有接口，路径穿越可读测试目录外文件 | 仅监听 127.0.0.1，规范化与 realpath 双重边界；cdn-smoke.test |
| 25 | Chromium 启动失败或关闭失败时测试 HTTP 服务器未关闭 | 完整 finally 资源清理；cdn-smoke.test |
| 26 | npm 查询把鉴权、网络错误当作包不存在，或按仓库子串误判可信绑定 | 仅结构化 E404 表示不存在；可信配置按仓库、工作流与权限精确检查，保留真实交互；first-publish、stage-release 测试 |
| 27 | 退出 prerelease 后 stage-release 仍强制读取 pre.json | 仅 ENOENT 表示 stable/latest，其他读取/解析失败继续阻断；stage-release.test |

Player.load 的 Promise 契约修正后，示例站和对应 TSDoc 片段同步处理拒绝：取消不制造未处理拒绝，真实错误保留原对象并报告。公共 API 返回 Promise 的包装不吞错。

直播资源预算只限制每轨保留的编码 payload；不包括解码器、后端队列和浏览器自身开销。高码率或高包率会缩短 15 秒历史窗口。非有限时间戳或单包超过预算会使连续段失效，视频等待下一个关键帧；有限 PTS 回退仍允许正常帧重排。

## 验证记录

Windows 完整 `pnpm check` 于 2026-11-07 18:26–18:27（UTC+8）执行，退出码 0：111 个测试文件、945 条测试全部通过，来源记录、文档文本、依赖边界、严格类型、构建、46 份许可/发布文件、顶层副作用、文档站、引擎按需块和全部体积预算均通过。新增针对性回归累计较基线增加 160 条。完整输出在负责人机器仓库外保存，stdout 40113 bytes、stderr 9508 bytes，SHA-256 分别为 44c06a6dd4f87b0e8f56044415d7fdba88bc55d5e70c221f9af7dec690a43952、3a2543331b3448b13c2b7b6a15ebaca120af5acc870a7f1f425ffb78ba85e545。

针对性测试覆盖上述失败路径；Windows 真实终端验证输入/输出均为 TTY，200 行 Unicode 输出完整保留，嵌套交互能收到测试文本，退出码 7 的受控失败保留 stdout/stderr。捕获工具覆盖 Node CLI 的流写入，不宣称捕获原生程序绕过 Node 流的直接文件描述符写入。

生产依赖审计 pnpm audit --prod --json 返回 0，无已报告 advisory；该命令的工作区依赖范围不等于所有浏览器端 peer/宿主组合已审计。

## 覆盖边界与发布门禁

本轮没有逐行审计所有 vendored 解析器、解码器和 DRM 第三方实现，也未补做 M7 手机/TV 实机矩阵；沿用 ADR-004/009 的阶段边界。回归用例证明其断言覆盖的路径，不证明不存在其他缺陷。

提交前必须 pnpm check 退出 0；推送后必须等待最终提交所有 CI 组完成，再执行完整首发 dry-run。最后一次旧基线 CI 成功不能代替新补丁 CI。正式发布遇到真实 2FA 提示再向负责人取码；非预期发布错误停止并保留完整输出。npm、版本标签、Pages 和上游 issue 按首发清单另行验收。
