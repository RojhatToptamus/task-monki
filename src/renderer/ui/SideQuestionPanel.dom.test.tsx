import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskInstruction } from '../../shared/contracts';
import { makeAgentItemRecord, makeRunRecord } from '../../testSupport/rendererRecords';
import type { AgentConversationRecords } from '../model/agentRecords';
import { SideQuestionPanel, type SideConversation } from './SideQuestionPanel';

function question(overrides: Partial<TaskInstruction> = {}): TaskInstruction {
  return {
    id: 'q1', taskId: 'task-1', iterationId: 'iteration-1', worktreeId: 'worktree-1', sessionId: 'session-q1',
    order: 1, text: 'Why a Map for buckets?', mode: 'FOLLOW_UP', status: 'SUBMITTED', role: 'SIDE',
    threadId: 'thread-1', runId: 'side-1', createdAt: '2026-10-10T09:59:00.000Z', updatedAt: '2026-10-10T09:59:00.000Z',
    ...overrides
  } as TaskInstruction;
}

const EMPTY: AgentConversationRecords = { runs: [], items: [], instructions: [], interactions: [], sessions: [], plans: [] };

function conversation(records: AgentConversationRecords = EMPTY): SideConversation {
  return {
    records,
    ask: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined)
  };
}

function Harness(props: { conversation: SideConversation; implementationActive?: boolean; runtimeUnavailable?: string; onUse?(text: string): void }) {
  const [draft, setDraft] = useState('');
  return (
    <SideQuestionPanel
      conversation={props.conversation}
      agentName="Codex"
      threadId="thread-1"
      implementationActive={props.implementationActive ?? false}
      runtimeUnavailable={props.runtimeUnavailable}
      draft={draft}
      onDraftChange={setDraft}
      onUseInFollowUp={props.onUse ?? (() => undefined)}
      onClose={() => undefined}
      docked
    />
  );
}

describe('SideQuestionPanel', () => {
  it('asks in the open thread', async () => {
    const side = conversation();
    render(<Harness conversation={side} implementationActive />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Ask Codex without interrupting it' }), { target: { value: 'Why a Map?' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });

    expect(side.ask).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1', text: 'Why a Map?' }));
  });

  it('offers a finished answer for the follow-up, introduced by its question', () => {
    const onUse = vi.fn();
    render(<Harness onUse={onUse} conversation={conversation({
      ...EMPTY,
      runs: [makeRunRecord({ id: 'side-1', mode: 'SIDE_QUESTION', status: 'COMPLETED', sessionId: 'session-q1', endedAt: '2026-10-10T10:00:00.000Z' } as never)],
      items: [makeAgentItemRecord({ id: 'answer', runId: 'side-1', sessionId: 'session-q1', payload: { text: 'Buckets are per process.' } })],
      instructions: [question(), question({ id: 'other', threadId: 'thread-0', text: 'An earlier thread', runId: 'side-0' })]
    })} />);

    expect(screen.queryByText('An earlier thread')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use in follow-up' }));
    expect(onUse).toHaveBeenCalledWith('From a side question, “Why a Map for buckets?”:\n\nBuckets are per process.');
  });

  it('takes one question at a time and can stop the one being answered', async () => {
    const side = conversation({
      ...EMPTY,
      runs: [makeRunRecord({ id: 'side-1', mode: 'SIDE_QUESTION', status: 'RUNNING', sessionId: 'session-q1', providerTurnId: 'turn-1' } as never)],
      instructions: [question()]
    });
    render(<Harness conversation={side} />);

    expect(screen.getByRole('textbox', { name: 'Ask Codex without interrupting it' })).toHaveProperty('disabled', true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop' })); });
    expect(side.stop).toHaveBeenCalledWith('side-1');
  });

  it('says why the runtime cannot answer before anything is written', () => {
    render(<Harness conversation={conversation()} runtimeUnavailable="Codex is not signed in." />);

    expect(screen.getByRole('textbox', { name: 'Ask Codex without interrupting it' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Codex is not signed in.')).toBeDefined();
  });
});
