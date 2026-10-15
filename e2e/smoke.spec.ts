import { expect, test } from './fixtures';
import type { FixtureResult } from './site/main';

test('packages load and run in the browser, core also inside a Worker', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/');
  const result = await page.evaluate<FixtureResult>(async () => {
    const pending = window.__otter;
    if (pending === undefined) throw new Error('fixture did not start');
    return pending;
  });

  expect(result.mainThread).toEqual({ paused: false, hotkeys: 24, surfaceKind: 'video' });
  expect(result.worker).toEqual({ paused: false, hasDocument: false });
  expect(result.capabilities).toBe(true);
  await expect(page.getByRole('status')).toHaveText('Ready');
  expect(errors).toEqual([]);
});
