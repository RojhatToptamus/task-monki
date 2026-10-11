import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import { codexCapabilities } from '../../core/agent/codex/codexCapabilities';
import type { AgentModel, AgentRuntimeState, AskSubject, TaskInstruction } from '../../shared/contracts';
import { makeAgentItemRecord, makeRunRecord } from '../../testSupport/rendererRecords';
import type { AgentConversationRecords } from '../model/agentRecords';
import { AskPanel, type AskConversation } from './AskPanel';

function question(overrides: Partial<TaskInstruction> = {}): TaskInstruction {
  return {
    id: 'q1', taskId: 'task-1', iterationId: 'iteration-1', worktreeId: 'worktree-1', sessionId: 'session-q1',
    order: 1, text: 'Why a Map for buckets?', mode: 'FOLLOW_UP', status: 'SUBMITTED', role: 'SIDE',
    threadId: 'thread-1', runId: 'side-1', createdAt: '2026-10-10T09:59:00.000Z', updatedAt: '2026-10-10T09:59:00.000Z',
    ...overrides
  } as TaskInstruction;
}

const EMPTY: AgentConversationRecords = { runs: [], items: [], instructions: [], interactions: [], sessions: [], plans: [] };

function conversation(records: AgentConversationRecords = EMPTY): AskConversation {
  return {
    records,
    ask: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined)
  };
}

const models: AgentModel[] = [
  { id: 'codex:openai/gpt-6.1-sol', runtimeId: 'codex', modelProvider: 'openai', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', hidden: false, isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', serviceTiers: [], inputModalities: ['text'] }
];

function runtime(readiness = createRuntimeReadiness('READY', 'Codex is ready.', { checks: { modelCatalog: 'AVAILABLE' } })): AgentRuntimeState {
  return {
    preflight: {
      runtime: { id: 'codex', displayName: 'Codex', kind: 'APP_SERVER', transport: 'STDIO', lifecycleScope: 'APPLICATION' },
      readiness,
      capabilities: codexCapabilities()
    },
    models,
    refreshedAt: '2026-10-10T09:00:00.000Z'
  } as AgentRuntimeState;
}

function Harness(props: { conversation: AskConversation; implementationActive?: boolean; runtimes?: AgentRuntimeState[]; onUse?(text: string): void; subject?: AskSubject }) {
  const [draft, setDraft] = useState('');
  const [subject, setSubject] = useState(props.subject);
  return (
    <AskPanel
      conversation={props.conversation}
      defaultModel={{ runtimeId: 'codex', model: 'gpt-6.1-sol', modelProvider: 'openai', reasoningEffort: 'low' }}
      models={models}
      runtimes={props.runtimes ?? [runtime()]}
      threadId="thread-1"
      implementationActive={props.implementationActive ?? false}
      draft={draft}
      onDraftChange={setDraft}
      subject={subject}
      onSubjectChange={setSubject}
      findingTitles={new Map([['f1', 'Retries skip the backoff']])}
      answerAction={{ label: 'Use in follow-up', onUse: props.onUse ?? (() => undefined) }}
      onClose={() => undefined}
      docked
    />
  );
}

describe('AskPanel', () => {
  it('asks in the open thread, on the model chosen for Ask', async () => {
    const side = conversation();
    render(<Harness conversation={side} implementationActive />);

    expect(screen.getByRole('button', { name: /Ask model reasoning effort: Low/ })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask about the work' }), { target: { value: 'Why a Map?' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });

    expect(side.ask).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      text: 'Why a Map?',
      model: { runtimeId: 'codex', model: 'gpt-6.1-sol', modelProvider: 'openai', reasoningEffort: 'low' }
    }));
  });

  it('asks about a finding until the person clears it, and names it above the question', async () => {
    const ask = conversation();
    const { rerender } = render(<Harness conversation={ask} subject={{ kind: 'FINDING', reviewRunId: 'review-1', findingId: 'f1' }} />);

    expect(screen.getByText('Retries skip the backoff')).toBeDefined();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask about this finding' }), { target: { value: 'Does this hold?' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(ask.ask).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Does this hold?', subject: { kind: 'FINDING', reviewRunId: 'review-1', findingId: 'f1' }
    }));
    // Once asked, the next question is about the whole task again.
    expect(screen.getByRole('textbox', { name: 'Ask about the work' })).toBeDefined();

    rerender(<Harness conversation={conversation({
      ...EMPTY,
      runs: [makeRunRecord({ id: 'side-1', mode: 'SIDE_QUESTION', status: 'COMPLETED', sessionId: 'session-q1', endedAt: '2026-10-10T10:00:00.000Z' } as never)],
      instructions: [question({ subject: { kind: 'LINES', path: 'src/retry.ts', side: 'NEW', line: 12, endLine: 14 } })]
    })} />);
    expect(screen.getByText('src/retry.ts:12-14')).toBeDefined();
  });

  it('can ask about the whole task instead of a subject', () => {
    render(<Harness conversation={conversation()} subject={{ kind: 'LINES', path: 'src/retry.ts', side: 'NEW', line: 12 }} />);

    expect(screen.getByRole('textbox', { name: 'Ask about this line' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Ask about the whole task instead' }));
    expect(screen.getByRole('textbox', { name: 'Ask about the work' })).toBeDefined();
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

    expect(screen.getByRole('textbox', { name: 'Ask about the work' })).toHaveProperty('disabled', true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop' })); });
    expect(side.stop).toHaveBeenCalledWith('side-1');
  });

  it('says why the chosen runtime cannot answer before anything is written', () => {
    render(<Harness conversation={conversation()} runtimes={[runtime(createRuntimeReadiness('AUTHENTICATION_REQUIRED', 'Codex is not signed in.'))]} />);

    expect(screen.getByRole('textbox', { name: 'Ask about the work' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Codex is not signed in.')).toBeDefined();
  });
});
