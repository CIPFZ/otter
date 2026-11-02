# @otter-player/vue

Vue 绑定（SPEC §16，ADR-013 第三批）：一个承载 preset 播放器的组件，加读 store 的 composable。范围与 `@otter-player/react` 一致：只经 store 的 `getState` / `subscribe`（宿主经 `dispatch` 下命令），不带 Otter 运行时，用哪个 preset 由宿主传入。Vue ≥ 3.3（peer）。

```vue
<script setup lang="ts">
import { shallowRef } from 'vue';
import { OtterPlayer, useOtterState } from '@otter-player/vue';
import { createVodPlayer } from '@otter-player/presets/vod';
import type { Player } from '@otter-player/presets';
import '@otter-player/ui-skin-default';

const props = defineProps<{ src: string }>();
const player = shallowRef<Player | null>(null);
const paused = useOtterState(() => player.value?.store, (s) => s.paused);
const create = (container: HTMLElement) => {
  const p = createVodPlayer({ container, title: '示例' });
  void p.load(props.src);
  return p;
};
</script>

<template>
  <OtterPlayer :create="create" :deps="[props.src]" poster="/poster.jpg" @player="(p) => (player = p as Player | null)" />
  <button @click="player?.store.dispatch(paused ? 'play' : 'pause', undefined)">{{ paused ? '播放' : '暂停' }}</button>
</template>
```

- `<OtterPlayer create deps aspectRatio poster @player>`：播放器在 `onMounted` 里创建，放在组件盒子里一个新建的子容器中；卸载或 `deps` 变化时销毁，子容器一并移除。
- `useOtterState(store, selector, equals?)`：`store` 可以是 store、ref 或 getter；返回 shallowRef，只在所选的那一片变化时更新。没有播放器时为 undefined。
- `useOtterPlayer(create, deps)`：组件背后的 composable。

## 服务端渲染

- setup 与 render 不碰 `window`、`document`、`AudioContext`。服务端与客户端首次渲染相同：带 `aspect-ratio`（默认 16 / 9）与可选 poster 的空盒子；`onMounted` 之后才建播放器。
- `useOtterState` 在服务端读 store 的初始状态（`getInitialState`），挂载后才订阅。
- 示例：`e2e/site/vue-{basic,vod,surveillance}.html`，构建时在 Node 里渲染，浏览器里 `createSSRApp(...).mount()` 水合；`e2e/bindings.spec.ts`。
