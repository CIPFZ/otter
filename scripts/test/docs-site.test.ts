import { describe, expect, it } from 'vitest';
import { markdown, presetExample } from '../docs-site.ts';

describe('docs site generator', () => {
  it('renders the README Markdown subset: headings one level down, lists, tables, code, inline marks', () => {
    const html = markdown('## A\n\nText with `code` and **bold** [link](x.html).\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1 < 2;\n```');
    expect(html).toContain('<h3>A</h3>');
    expect(html).toContain('<p>Text with <code>code</code> and <strong>bold</strong> <a href="x.html">link</a>.</p>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>');
    expect(html).toContain('<pre><code class="lang-ts">const x = 1 &lt; 2;</code></pre>');
  });

  it("takes a preset's block out of the example page, nested braces included", () => {
    const site = "if (kind === 'a') {\n  x({ y: { z: 1 } });\n} else if (kind === 'b') {\n  b();\n}";
    expect(presetExample(site, 'a')).toBe('x({ y: { z: 1 } });');
    expect(presetExample(site, 'b')).toBe('b();');
    expect(presetExample(site, 'c')).toBe('');
  });
});
