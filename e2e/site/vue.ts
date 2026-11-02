// Client entry of the Vue example pages: hydrates the server-rendered app (#root). A production
// Vue build reports a hydration mismatch only on the console: collected for the tests.
import { createExampleApp } from './vue-app.ts';
import type { ExamplePreset } from './example-presets.ts';

const preset = document.documentElement.dataset['preset'] as ExamplePreset;
window.hydrationErrors = [];
const error = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (/hydration/i.test(String(args[0]))) window.hydrationErrors?.push(String(args[0]));
  error(...args);
};
createExampleApp(preset, (p) => (window.examplePlayer = p)).mount(document.getElementById('root') as HTMLElement);
