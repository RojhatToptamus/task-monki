import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OpenTargetContextMenu } from './OpenTargetMenu';

describe('OpenTargetContextMenu', () => {
  it('keeps the loading row inside the menu contract while the action model resolves', () => {
    const html = renderToStaticMarkup(
      <OpenTargetContextMenu
        target={{ type: 'repository', repositoryId: 'repository-1' }}
        position={{ x: 20, y: 20 }}
        onClose={() => undefined}
      />
    );

    expect(html).toContain('role="menu"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('role="menuitem" aria-disabled="true"');
    expect(html).toContain('Loading...');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });
});
