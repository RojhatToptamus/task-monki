import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepositorySwitcher } from './RepositorySwitcher';

describe('RepositorySwitcher', () => {
  it('names the neutral control as the default destination without a status dot', () => {
    const html = renderToStaticMarkup(
      <RepositorySwitcher
        activeRepositoryId="repository-1"
        options={[
          {
            id: 'repository-1',
            name: 'repo-secondary',
            path: '/Users/dev/work/repo-secondary',
            displayPath: '…/work/repo-secondary',
            taskCount: 2,
            status: 'AVAILABLE'
          }
        ]}
        collapsed={false}
        adding={false}
        onSelect={() => undefined}
        onAddRepository={async () => false}
        onRefreshRepository={async () => undefined}
        onReconnectRepository={async () => undefined}
        onDisconnectRepository={async () => undefined}
      />
    );

    expect(html).toContain('New task repository');
    expect(html).toContain('aria-label="New task repository: repo-secondary"');
    expect(html).toContain('repo-secondary');
    expect(html).not.toContain('tm-nav__repo-dot');
  });
});
