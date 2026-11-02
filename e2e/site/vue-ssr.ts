// Server render of the Vue example page (e2e/framework-ssr.ts loads this in Node).
import { renderToString } from 'vue/server-renderer';
import { createExampleApp } from './vue-app.ts';
import type { ExamplePreset } from './example-presets.ts';

export const render = (preset: ExamplePreset): Promise<string> => renderToString(createExampleApp(preset));
