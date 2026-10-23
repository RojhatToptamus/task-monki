import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SyntaxCode } from './SyntaxCode';

describe('syntax code', () => {
  it('sets each run in its kind and keeps every character of the line, after what changed', () => {
    const html = renderToStaticMarkup(
      <SyntaxCode
        text={"const a = 'x'; // b"}
        kind="addition"
        tokens={[{ from: 0, to: 5, kind: 'keyword' }, { from: 10, to: 13, kind: 'string' }, { from: 15, to: 19, kind: 'comment' }]}
      />
    );
    expect(html).toBe(
      '<code><span class="tm-visually-hidden">Added: </span><span class="tm-syn-keyword">const</span> a = '
        + '<span class="tm-syn-string">&#x27;x&#x27;</span>; <span class="tm-syn-comment">// b</span></code>'
    );
  });

  it('reads plain until its runs arrive, and an empty line keeps its height', () => {
    expect(renderToStaticMarkup(<SyntaxCode text="old();" kind="deletion" />)).toBe(
      '<code><span class="tm-visually-hidden">Removed: </span>old();</code>'
    );
    expect(renderToStaticMarkup(<SyntaxCode text="" kind="context" tokens={[]} />)).toBe('<code> </code>');
  });
});
