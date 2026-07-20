import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiscourseMentionInput } from './DiscourseMentionInput';

describe('DiscourseMentionInput accessibility prototype', () => {
  it('renders a labeled multiline combobox with a separate grouped listbox', () => {
    const html = renderToStaticMarkup(
      <DiscourseMentionInput
        initialText="Ask @"
        candidates={[
          {
            kind: 'AGENT',
            id: 'builtin.verifier',
            label: 'Verifier',
            description: 'Checks claims against evidence',
            searchAliases: ['reviewer'],
            available: true
          },
          {
            kind: 'TASK',
            id: 'task-1',
            label: 'Fix login',
            description: 'Ready · repo-a',
            searchAliases: ['task-1'],
            available: true
          },
          {
            kind: 'REPOSITORY',
            id: 'repository-1',
            label: 'repo-a',
            description: '2 tasks',
            searchAliases: ['repos/repo-a'],
            available: false
          }
        ]}
      />
    );

    expect(html).toContain('<label');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-multiline="true"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/aria-activedescendant="discourse-option-[^"]+-AGENT-builtin-verifier"/u);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="group" aria-label="Agents"');
    expect(html).toContain('role="group" aria-label="Tasks"');
    expect(html).toContain('role="group" aria-label="Repositories"');
    expect(html).toContain('role="option" aria-selected="true"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('role="status"');
  });

  it('keeps option identities distinct when entity kinds share an id', () => {
    const html = renderToStaticMarkup(
      <DiscourseMentionInput
        initialText="@shared"
        candidates={[
          {
            kind: 'TASK', id: 'shared', label: 'Shared task', description: 'Task',
            searchAliases: [], available: true
          },
          {
            kind: 'REPOSITORY', id: 'shared', label: 'Shared repository',
            description: 'Repository', searchAliases: [], available: true
          }
        ]}
      />
    );

    expect(html).toMatch(/id="discourse-option-[^"]+-TASK-shared"/u);
    expect(html).toMatch(/id="discourse-option-[^"]+-REPOSITORY-shared"/u);
  });
});
