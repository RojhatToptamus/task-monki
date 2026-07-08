import { describe, expect, it } from 'vitest';
import {
  PULL_REQUEST_TITLE_MAX_LENGTH,
  normalizePullRequestTitle
} from './contracts';

describe('pull request title normalization', () => {
  it('uses an edited title after trimming internal whitespace', () => {
    expect(normalizePullRequestTitle('  Add   settings\npanel  ', 'Task title')).toBe(
      'Add settings panel'
    );
  });

  it('falls back to the task title when the edited title is blank', () => {
    expect(normalizePullRequestTitle('   ', '  Default   PR title  ')).toBe(
      'Default PR title'
    );
  });

  it('bounds generated titles for the GitHub create request', () => {
    const title = normalizePullRequestTitle('x'.repeat(PULL_REQUEST_TITLE_MAX_LENGTH + 20), 'Task');

    expect(title).toHaveLength(PULL_REQUEST_TITLE_MAX_LENGTH);
  });
});
