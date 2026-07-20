import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImpactList } from './ImpactList';

describe('ImpactList', () => {
  it('uses one textual Deleted, Kept, and Untouched list grammar without decorative dots', () => {
    const html = renderToStaticMarkup(
      <ImpactList
        ariaLabel="Deletion impact"
        groups={[
          { kind: 'deleted', items: ['Task record'] },
          { kind: 'kept', items: ['Git history'] },
          { kind: 'untouched', items: ['Open pull request'] }
        ]}
      />
    );

    expect(html).toContain(
      '<div class="tm-impact-list" role="group" aria-label="Deletion impact">'
    );
    expect(html).toContain('data-impact-kind="deleted"');
    expect(html).toContain('<h4>Deleted</h4>');
    expect(html).toContain('<h4>Kept</h4>');
    expect(html).toContain('<h4>Untouched</h4>');
    expect(html).not.toContain('dot');
  });
});
