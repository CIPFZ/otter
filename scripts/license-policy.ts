// License policy for scripts/license-gate.ts. Mirrors REUSE.md §2; change both together.

import type { LicensePolicy } from './lib/license.ts';

export const policy: LicensePolicy = {
  // REUSE §2: Apache-2.0 / MIT / BSD at every reuse level. ISC and 0BSD are MIT-equivalent.
  permissive: ['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'],
  // Build and test tooling only; never acceptable in a shipped dependency tree.
  tooling: [
    'MPL-2.0',
    'CC0-1.0',
    'CC-BY-3.0',
    'CC-BY-4.0',
    'BlueOak-1.0.0',
    'Python-2.0',
    'Unlicense',
    'MIT-0',
    'Zlib',
  ],
  // REUSE §2: LGPL only as a separately loaded WASM / dynamic module in these packages.
  lgplOwners: [/^@otter-player\/decoder-/, /^@otter-player\/text-ass$/],
  overrides: {},
};
