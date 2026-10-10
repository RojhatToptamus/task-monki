import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewFindingDecision } from '../../shared/agentReviewFindings';
import type { TaskInstruction } from '../../shared/contracts';
import { makeAgentItemRecord, makeRunRecord } from '../../testSupport/rendererRecords';
import type { ReviewFindingView } from '../model/reviewWorkspace';
import { ReviewerPanel, type ReviewerConversation } from './ReviewerPanel';

const finding: ReviewFindingView = {
  id: 'f2', severity: 'MINOR', title: 'Retry-After is in milliseconds', explanation: 'The header expects seconds.', state: 'WITHDRAWN', addedByReviewer: false,
  revision: { kind: 'WITHDRAW', reason: 'msUntilNextToken returns seconds.', decidedAt: '2026-10-10T10:00:00.000Z' }
};

function question(overrides: Partial<TaskInstruction> = {}): TaskInstruction {
  return {
    id: 'q1', taskId: 'task-1', iterationId: 'iteration-1', worktreeId: 'worktree-1', sourceRunId: 'review-1', sessionId: 'session-q1',
    order: 1, text: 'msUntilNextToken already returns seconds.', mode: 'FOLLOW_UP', status: 'SUBMITTED', role: 'REVIEW',
    reviewRunId: 'review-1', findingId: 'f2', runId: 'ask-1', createdAt: '2026-10-10T09:59:00.000Z', updatedAt: '2026-10-10T09:59:00.000Z',
    ...overrides
  };
}

function conversation(overrides: Partial<ReviewerConversation> = {}): ReviewerConversation {
  return {
    records: {
      runs: [makeRunRecord({ id: 'ask-1', mode: 'REVIEW_QUESTION', status: 'COMPLETED', sessionId: 'session-q1', continuedFromRunId: 'review-1', endedAt: '2026-10-10T10:00:00.000Z' })],
      items: [makeAgentItemRecord({
        id: 'answer', runId: 'ask-1', sessionId: 'session-q1',
        payload: { text: "You're right: it divides by 1000.\n\n```task-monki-revisions\n[{\"finding\":\"f2\",\"action\":\"withdraw\",\"reason\":\"msUntilNextToken returns seconds.\"}]\n```" }
      })],
      instructions: [question()],
      interactions: [],
      sessions: [],
      plans: []
    },
    ask: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    ...overrides
  };
}

const withdrawal: ReviewFindingDecision = {
  id: 'd1', reviewRunId: 'review-1', findingId: 'f2', kind: 'WITHDRAW', actor: 'REVIEWER', reason: 'msUntilNextToken returns seconds.',
  questionRunId: 'ask-1', createdAt: '2026-10-10T10:00:00.000Z'
};

function Harness(props: { conversation: ReviewerConversation; stale?: boolean; focus?: ReviewFindingView }) {
  const [draft, setDraft] = useState('');
  const [focus, setFocus] = useState(props.focus);
  return (
    <ReviewerPanel
      conversation={props.conversation}
      reviewerName="Claude"
      reviewRunId="review-1"
      stale={props.stale ?? false}
      findings={[finding]}
      decisions={[withdrawal]}
      focusFinding={focus}
      onClearFocus={() => setFocus(undefined)}
      draft={draft}
      onDraftChange={setDraft}
      onClose={() => undefined}
      docked
    />
  );
}

describe('ReviewerPanel', () => {
  it('shows the answer as prose with each revision it made as one line, never the raw block', () => {
    render(<Harness conversation={conversation()} />);

    expect(screen.getByText("You're right: it divides by 1000.")).toBeDefined();
    expect(screen.queryByText(/task-monki-revisions/)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Withdrew Retry-After is in milliseconds');
    expect(screen.getByText('Retry-After is in milliseconds', { selector: '.tm-reviewer__about-line' })).toBeDefined();
  });

  it('asks about the focused finding, then the next question is about the whole review', async () => {
    const reviewer = conversation({ records: { runs: [], items: [], instructions: [], interactions: [], sessions: [], plans: [] } });
    render(<Harness conversation={reviewer} focus={{ ...finding, state: 'OPEN', revision: undefined }} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Ask about this finding' }), { target: { value: 'Is this still minor?' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });

    expect(reviewer.ask).toHaveBeenCalledWith(expect.objectContaining({ reviewRunId: 'review-1', text: 'Is this still minor?', findingId: 'f2' }));
    expect(screen.getByRole('textbox', { name: 'Ask about this review' })).toBeDefined();
  });

  it('keeps a stale review readable but takes no new questions', () => {
    render(<Harness conversation={conversation()} stale />);

    expect(screen.getByText("You're right: it divides by 1000.")).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Ask about this review' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Review out of date')).toBeDefined();
  });
});
