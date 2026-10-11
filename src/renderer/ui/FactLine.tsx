/**
 * Short facts on one line, each its own span 8px apart, never joined by a
 * separator glyph (DESIGN.md §5). The gap is a generated space, so assistive
 * technology reads the facts as separate words. The surrounding element sets
 * the type and colour.
 */
export function FactLine({ facts }: { facts: readonly string[] }) {
  return <span className="tm-fact-line">{facts.map((fact, index) => <span key={index}>{fact}</span>)}</span>;
}
