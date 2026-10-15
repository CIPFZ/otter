import { describe, expect, it } from 'vitest';
import { createCore } from '@otter-player/core';
import { createAnalyticsPlugin } from '@otter-player/plugin-analytics';
import { createCastPlugin } from '@otter-player/plugin-cast';
import { createP2pPlugin } from '@otter-player/plugin-p2p';
import { createRecordPlugin } from '@otter-player/plugin-record';
import { createScreenshotPlugin } from '@otter-player/plugin-screenshot';
import { PRESET_IDS } from '@otter-player/presets';

describe('plugins', () => {
  it.each([
    ['cast', createCastPlugin],
    ['analytics', createAnalyticsPlugin],
    ['p2p', createP2pPlugin],
    ['record', createRecordPlugin],
    ['screenshot', createScreenshotPlugin],
  ] as const)('%s plugin fails install loudly and rolls back', async (id, create) => {
    const plugin = create();
    expect(plugin.id).toBe(id);
    const core = createCore({ plugins: [plugin] });
    await expect(core.start()).rejects.toMatchObject({
      details: 'pluginInstallFailed',
      cause: expect.objectContaining({ details: 'notImplemented' }),
    });
  });
});

describe('presets', () => {
  it('lists the SPEC §3 scenarios', () => {
    expect(PRESET_IDS).toHaveLength(9);
    expect(new Set(PRESET_IDS).size).toBe(9);
  });
});
