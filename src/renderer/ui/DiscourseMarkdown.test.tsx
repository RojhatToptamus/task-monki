import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiscourseMarkdown } from './DiscourseMarkdown';

describe('DiscourseMarkdown', () => {
  it('renders common model-answer structure without injecting HTML', () => {
    const html = renderToStaticMarkup(
      <DiscourseMarkdown text={'## Decision\n\n- **Keep** history\n- Show `FAILED`\n\n```ts\nconst safe = true;\n```\n\n<script>alert(1)</script>'} />
    );
    expect(html).toContain('<h3>Decision</h3>');
    expect(html).toContain('<ul><li><strong>Keep</strong> history</li>');
    expect(html).toContain('<code>FAILED</code>');
    expect(html).toContain('<pre><code>const safe = true;</code></pre>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('matches the shell policy by linking only credential-free HTTPS URLs', () => {
    const html = renderToStaticMarkup(
      <DiscourseMarkdown text={'[Docs](https://example.com) [http](http://example.com) [credentials](https://user:secret@example.com) [unsafe](javascript:alert(1))'} />
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('href="http://');
    expect(html).not.toContain('user:secret');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('unsafe');
  });
});
