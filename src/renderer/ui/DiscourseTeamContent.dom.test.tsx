import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiscourseMessageRecord, DiscourseTeamComparison } from '../../shared/discourse';
import { DiscourseTeamContent } from './DiscourseTeamContent';

describe('Team comparison and direct responses', () => {
  it('preserves disagreement, qualifies confidence, and links the exact source message', () => {
    const onNavigate = vi.fn();
    const result: DiscourseTeamComparison = {
      kind: 'COMPARISON', summary: 'The authors use different rollback assumptions.',
      points: [{ id: 'P1', question: 'Which support window applies?', importance: 'MATERIAL', status: 'DISAGREED',
        explanation: 'A defends a longer support window. B prefers one release.', sourceMessageIds: ['answer-a'],
        evidence: ['The support policy remains unknown.'], confidence: 'LOW' }],
      next: 'OPEN_DISAGREEMENT', reason: 'The user must choose the policy.', actions: []
    };
    render(<DiscourseTeamContent result={result} sources={[{
      id: 'answer-a', ordinal: 2, author: { kind: 'AGENT', displayNameSnapshot: 'A' }
    } as DiscourseMessageRecord]} onNavigate={onNavigate} />);
    expect(screen.getByText('Disagreed')).toBeTruthy();
    expect(screen.getByText('Low confidence · C’s assessment')).toBeTruthy();
    expect(screen.getByText('Evidence cited by C')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'A · 2' }));
    expect(onNavigate).toHaveBeenCalledWith('answer-a');
  });

  it('shows an author abstention and correction to C without presenting agreement', () => {
    render(<DiscourseTeamContent result={{ kind: 'RESPONSE', responses: [{
      pointId: 'P1', stance: 'ABSTAIN', answer: 'I cannot determine the support policy.',
      reason: 'The user has not supplied it.', evidence: []
    }], newIssues: ['C attributed a requirement to me that I did not state.'] }} sources={[]} onNavigate={vi.fn()} />);
    expect(screen.getByText('P1 · Abstain')).toBeTruthy();
    expect(screen.getByText('C attributed a requirement to me that I did not state.')).toBeTruthy();
    expect(screen.queryByText('Agreed')).toBeNull();
  });
});
