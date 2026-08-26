import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImpactList } from './ImpactList';

describe('ImpactList', () => {
  it('uses one accessible textual Deleted, Kept, and Untouched list grammar', () => {
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

    expect(html).toContain('role="group" aria-label="Deletion impact"');
    expect(html).toContain('data-impact-kind="deleted"');
    expect(html).toContain('<h4>Deleted</h4>');
    expect(html).toContain('<h4>Kept</h4>');
    expect(html).toContain('<h4>Untouched</h4>');
  });
});
