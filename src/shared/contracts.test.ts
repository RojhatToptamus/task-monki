import { describe, expect, it } from 'vitest';
import {
  BOARD_COLORS,
  PULL_REQUEST_TITLE_MAX_LENGTH,
  normalizePullRequestTitle
} from './contracts';

describe('saved-view colors', () => {
  it('keeps the categorical palette small, stable, and unique', () => {
    expect(BOARD_COLORS).toEqual([
      'NEUTRAL',
      'BLUE',
      'AMBER',
      'GREEN',
      'ROSE',
      'VIOLET'
    ]);
    expect(new Set(BOARD_COLORS).size).toBe(BOARD_COLORS.length);
  });
});

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
