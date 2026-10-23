import { memo, type ReactNode } from 'react';
import type { DiffLineKind } from '../model/diffEvidence';
import type { TokenLine } from '../model/syntaxHighlight';

/**
 * A line of code in its syntax colour: each run a span of its kind's class, the
 * text between them plain, and plain throughout until its runs arrive. A changed
 * line says so first, for a screen reader.
 */
export const SyntaxCode = memo(function SyntaxCode({ text, tokens, kind }: {
  text: string;
  tokens?: TokenLine;
  kind?: DiffLineKind;
}) {
  return (
    <code>
      {kind === 'addition' || kind === 'deletion' ? (
        <span className="tm-visually-hidden">{kind === 'addition' ? 'Added: ' : 'Removed: '}</span>
      ) : null}
      {tokens?.length ? runs(text, tokens) : text || ' '}
    </code>
  );
});

function runs(text: string, tokens: TokenLine): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { from, to, kind } of tokens) {
    if (from > at) parts.push(text.slice(at, from));
    parts.push(<span key={from} className={`tm-syn-${kind}`}>{text.slice(from, to)}</span>);
    at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
