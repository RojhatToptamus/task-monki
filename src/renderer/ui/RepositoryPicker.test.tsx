import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RepositoryOption } from '../model/repositories';
import { RepositoryPicker, RepositorySelect } from './RepositoryPicker';

describe('RepositoryPicker', () => {
  it('renders the selected repository without a hidden form-control path', () => {
    const html = renderToStaticMarkup(
      <RepositorySelect
        options={[repositoryOption()]}
        selectedId="repository-1"
        ariaLabel="Task repository"
        onChange={() => undefined}
      />
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain(
      'aria-label="Task repository: project, /Users/dev/work/project"'
    );
    expect(html).toContain('<strong>project</strong>');
    expect(html).toContain('title="/Users/dev/work/project"');
    expect(html).toContain('…/work/project');
    expect(html).not.toContain('type="search"');
    expect(html).not.toContain('type="radio"');
  });

  it('disables the task repository trigger when no repository is available', () => {
    const html = renderToStaticMarkup(
      <RepositorySelect
        options={[]}
        selectedId=""
        disabled
        ariaLabel="Task repository"
        onChange={() => undefined}
      />
    );

    expect(html).toContain('aria-label="Task repository: No repositories available"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('<strong>No repositories available</strong>');
    expect(html).not.toContain('Search repositories');
  });

  it('renders the searchable saved-view multi-select with availability status', () => {
    const html = renderToStaticMarkup(
      <RepositoryPicker
        options={[repositoryOption({ status: 'DISCONNECTED' })]}
        selectedIds={[]}
        ariaLabel="Saved-view repositories"
        onChange={() => undefined}
      />
    );

    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Search repositories"');
    expect(html).toContain('role="group"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('Disconnected');
  });

  it('renders the empty saved-view filter without a second selection path', () => {
    const html = renderToStaticMarkup(
      <RepositoryPicker
        options={[]}
        selectedIds={[]}
        disabled
        ariaLabel="Saved-view repositories"
        onChange={() => undefined}
      />
    );

    expect(html).toContain('aria-label="Saved-view repositories"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('No repositories found.');
    expect(html).not.toContain('type="radio"');
  });
});

function repositoryOption(overrides: Partial<RepositoryOption> = {}): RepositoryOption {
  return {
    id: 'repository-1',
    name: 'project',
    path: '/Users/dev/work/project',
    displayPath: '…/work/project',
    taskCount: 0,
    status: 'AVAILABLE',
    ...overrides
  };
}
