// Client entry of the React example pages: hydrates the server-rendered app (#root) for the page's
// preset (<html data-preset>). window.preset is the player, for the tests.
import { hydrateRoot } from 'react-dom/client';
import { App, type ExamplePlayer, type ExamplePreset } from './react-app.tsx';

declare global {
  interface Window {
    reactPlayer?: ExamplePlayer | null;
    hydrationErrors?: string[];
  }
}

const preset = document.documentElement.dataset['preset'] as ExamplePreset;
window.hydrationErrors = [];
hydrateRoot(document.getElementById('root') as HTMLElement, <App preset={preset} onPlayer={(p) => (window.reactPlayer = p)} />, {
  onRecoverableError: (e) => window.hydrationErrors?.push(String(e)),
});
