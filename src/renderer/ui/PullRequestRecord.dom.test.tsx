import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PullRequestRefresh } from './PullRequestRecord';

describe('PullRequestRefresh', () => {
  it('says why it cannot refresh where the time was, tied to the control, so the keyboard reaches it', () => {
    const description = (element: HTMLElement) => (element.getAttribute('aria-describedby') ?? '').split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    const refresh = (disabled: boolean) => (
      <PullRequestRefresh updated="Updated 2m ago" noun="pull request" disabled={disabled}
        reason={disabled ? 'GitHub action is in progress.' : undefined} onRefresh={vi.fn()} />
    );
    const { rerender } = render(refresh(true));
    const button = screen.getByRole('button', { name: 'Refresh pull request' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(description(button)).toBe('GitHub action is in progress.');
    expect(screen.queryByText('Updated 2m ago')).toBeNull();

    rerender(refresh(false));
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.getByText('Updated 2m ago')).toBeDefined();
  });
});
