// Server render of the React example page (e2e/framework-ssr.ts loads this in Node).
import { renderToString } from 'react-dom/server';
import { App } from './react-app.tsx';
import type { ExamplePreset } from './example-presets.ts';

export const render = (preset: ExamplePreset): Promise<string> => Promise.resolve(renderToString(<App preset={preset} />));
