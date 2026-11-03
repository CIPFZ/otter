# @otter-player/input

键盘、指针与手势到动作的统一映射（SPEC §14.3）。主入口是 `createInputController`；电视遥控器在 sub-path `@otter-player/input/remote`（只有 TV 播放器带它）。

## 遥控器：`@otter-player/input/remote`

```ts
import { bindRemote, DEFAULT_REMOTE_KEYS } from '@otter-player/input/remote';

const off = bindRemote(playerRoot, player.store, {
  // 某个逻辑键的表整体替换；其余用默认。
  keys: { back: [...DEFAULT_REMOTE_KEYS.back, 8] },
  // 按住左右（或快进 / 快退键）时每一步的秒数：按住多久（ms）→ 秒。
  seek: { steps: [[0, 10], [1500, 30], [4000, 60]], intervalMs: 250 },
});
```

tv preset 已经接好，用 `createTvPlayer({ ..., remote: { keys, seek } })` 传同样的选项。

- 画面上（没有控件获得焦点）：上 / 下呼出控件并聚焦播放键；左 / 右快退 / 快进，按住会加速；OK 播放 / 暂停。
- 控件里：方向键移到最近的控件（空间导航）；Back 先关菜单，再离开控件。
- 媒体键（播放 / 暂停、快进 / 快退）任何时候都有效；切换类的键不跟着按键重复触发。

### 默认值的来源

**默认值取自常见实现，不是厂商规范，都可以配置**：

| 逻辑键 | 默认 |
|---|---|
| Back | `Escape`、`GoBack`、`BrowserBack`、`Backspace`；Tizen 10009；webOS 461 |
| 播放 / 暂停 | `MediaPlayPause`；Tizen 10252 |
| 播放、暂停 | `MediaPlay` / 415；`MediaPause` / 19 |
| 快进、快退 | `MediaFastForward` / 417；`MediaRewind` / 412 |
| 方向键、OK | `ArrowUp` / `ArrowDown` / `ArrowLeft` / `ArrowRight`、`Enter` |

- 平台 keyCode 是 Tizen、webOS 与 HbbTV 网页应用里常见的值，各厂商、各代机型可能不同。
- 长按步长（10 s，按住 1.5 s 后 30 s，4 s 后 60 s；每 250 ms 至多一步）参照常见电视播放器的手感定的，没有标准。
- 真遥控器与 webOS 模拟器上的核对列在 M7 清单里（`docs/reports/M6.md`），不等模拟器。
