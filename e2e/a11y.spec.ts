// axe scan (SPEC §1.1 / §14.5: WCAG 2.2 AA). Serious and critical violations fail the run; the
// full result is attached to the report.

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('fixture page has no serious or critical axe violations', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Ready');

  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  await testInfo.attach('axe-results.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });

  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.help} [${v.nodes.map((n) => n.target.join(' ')).join(', ')}]`);
  expect(blocking).toEqual([]);
});
