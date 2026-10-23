import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SyntaxCode } from './SyntaxCode';

/** What the line reads as, its tags gone. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");

describe('syntax code', () => {
  it('keeps every character of the line in order with each run in its kind, and an empty line keeps its height', () => {
    const html = renderToStaticMarkup(
      <SyntaxCode
        text={"const a = 'x'; // b"}
        kind="context"
        tokens={[{ from: 0, to: 5, kind: 'keyword' }, { from: 10, to: 13, kind: 'string' }, { from: 15, to: 19, kind: 'comment' }]}
      />
    );
    expect(textOf(html)).toBe("const a = 'x'; // b");
    expect(html).toContain('<span class="tm-syn-keyword">const</span>');
    expect(html).toContain('<span class="tm-syn-comment">// b</span>');
    expect(textOf(renderToStaticMarkup(<SyntaxCode text="" kind="context" tokens={[]} />))).toBe(' ');
  });
});
