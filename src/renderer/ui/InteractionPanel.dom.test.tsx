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

  it('lets a Design user return every choice to the agent exactly once', async () => {
    const onRespond = vi.fn(async () => undefined);
    const interaction = userInputInteraction();
    interaction.request = {
      questions: [
        {
          id: 'audience',
          header: 'Audience',
          question: 'Who is this page for?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'New customers', description: 'Explain the service first.' },
            { label: 'Existing customers', description: 'Focus on repeat actions.' }
          ]
        },
        {
          id: 'scope',
          header: 'Scope',
          question: 'What is the main flow?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Browse', description: 'Show information only.' },
            { label: 'Order', description: 'Include a purchase flow.' }
          ]
        }
      ]
    };

    render(
      <InteractionPanel
        interactions={[interaction]}
        sessions={[]}
        offerAgentDecision
        onRespond={onRespond}
      />
    );

    const decide = screen.getByRole('button', { name: 'Decide for me' });
    fireEvent.click(decide);
    fireEvent.click(decide);

    expect(onRespond).toHaveBeenCalledOnce();
    expect(onRespond).toHaveBeenCalledWith(interaction, {
      interactionType: 'USER_INPUT',
      action: 'ANSWER',
      answers: {
        audience: ['Decide for me'],
        scope: ['Decide for me']
      }
    });
  });

  it('hides agent delegation when the provider does not accept custom input', () => {
    const interaction = userInputInteraction();
    interaction.request = {
      questions: [
        {
          id: 'scope',
          header: 'Scope',
          question: 'Which scope should the agent use?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Small', description: 'Use the focused scope.' },
            { label: 'Large', description: 'Use the expanded scope.' }
          ]
        }
      ]
    };

    render(
      <InteractionPanel
        interactions={[interaction]}
        sessions={[]}
        offerAgentDecision
        onRespond={vi.fn(async () => undefined)}
      />
    );

    expect(screen.queryByRole('button', { name: 'Decide for me' })).toBeNull();
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
