// Client entry of the React example pages: hydrates the server-rendered app (#root) for the page's
// preset (<html data-preset>).
import { hydrateRoot } from 'react-dom/client';
import { App } from './react-app.tsx';
import type { ExamplePreset } from './example-presets.ts';

const preset = document.documentElement.dataset['preset'] as ExamplePreset;
window.hydrationErrors = [];
hydrateRoot(document.getElementById('root') as HTMLElement, <App preset={preset} onPlayer={(p) => (window.examplePlayer = p)} />, {
  onRecoverableError: (e) => window.hydrationErrors?.push(String(e)),
});
