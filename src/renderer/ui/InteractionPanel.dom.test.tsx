import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InteractionRequestRecord } from '../../shared/contracts';
import { InteractionPanel } from './InteractionPanel';

describe('mounted agent user-input interaction', () => {
  it('submits native multiple-choice, custom, and free-text answers exactly once', async () => {
    const onRespond = vi.fn(async () => undefined);
    render(
      <InteractionPanel
        interactions={[userInputInteraction()]}
        sessions={[]}
        onRespond={onRespond}
      />
    );

    const submit = screen.getByRole('button', { name: 'Submit answers' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    const checks = screen.getByRole('group', { name: 'Checks' });
    fireEvent.click(within(checks).getByRole('checkbox', { name: /Unit/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Checks other answer' }), {
      target: { value: 'Smoke' }
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Detail/ }), {
      target: { value: 'Preserve current behavior.' }
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(onRespond).toHaveBeenCalledOnce();
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'interaction-input' }),
      {
        interactionType: 'USER_INPUT',
        action: 'ANSWER',
        answers: {
          checks: ['Unit', 'Smoke'],
          detail: ['Preserve current behavior.']
        }
      }
    );
  });
});

function userInputInteraction(): InteractionRequestRecord {
  return {
    id: 'interaction-input',
    runtimeId: 'opencode',
    serverInstanceId: 'server-1',
    providerRequestId: 'question-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    providerTurnId: 'message-1',
    type: 'USER_INPUT',
    status: 'PENDING',
    request: {
      questions: [
        {
          id: 'checks',
          header: 'Checks',
          question: 'Which checks should run?',
          isOther: true,
          isSecret: false,
          allowsMultiple: true,
          options: [
            { label: 'Unit', description: 'Run focused unit tests.' },
            { label: 'Build', description: 'Build the application.' }
          ]
        },
        {
          id: 'detail',
          header: 'Detail',
          question: 'What should the agent preserve?',
          isOther: false,
          isSecret: false
        }
      ]
    },
    allowedActions: ['ANSWER'],
    policyWarnings: [],
    requestRawMessage: {
      serverInstanceId: 'server-1',
      sequence: 1,
      direction: 'INBOUND',
      recordedAt: '2026-07-25T10:00:00.000Z',
      byteOffset: 0,
      byteLength: 1,
      sha256: 'hash'
    },
    requestedAt: '2026-07-25T10:00:00.000Z'
  };
}
