import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InteractionRequestRecord } from '../../shared/contracts';
import { InteractionPanel } from './InteractionPanel';

describe('mounted agent user-input interaction', () => {
  it('submits native multiple-choice, custom, and free-text answers exactly once', async () => {
    let finish!: () => void;
    const onRespond = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(
      <InteractionPanel
        interactions={[userInputInteraction()]}
        sessions={[]}
        onRespond={onRespond}
      />
    );

    const submit = screen.getByRole('button', { name: 'Submit answers' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    const checks = screen.getByRole('group', { name: 'Which checks should run?' });
    fireEvent.click(within(checks).getByRole('checkbox', { name: /Unit/ }));
    expect(screen.queryByRole('textbox', { name: 'Checks other answer' })).toBeNull();
    fireEvent.click(within(checks).getByRole('checkbox', { name: 'Other…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Checks other answer' }), {
      target: { value: 'Smoke' }
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'What should the agent preserve?' }), {
      target: { value: 'Preserve current behavior.' }
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(screen.getByRole('button', { name: 'Sending…' }).getAttribute('aria-busy')).toBe('true');
    expect(within(checks).getByRole('checkbox', { name: /Unit/ })).toHaveProperty('disabled', true);
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
    finish();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sending…' })).toBeNull());
  });

  it('keeps failed approval delivery recoverable without exposing transport diagnostics as the alert', async () => {
    const interaction = { ...userInputInteraction(), type: 'PERMISSION_APPROVAL' as const,
      allowedActions: ['GRANT_TURN', 'DECLINE'] as InteractionRequestRecord['allowedActions'],
      request: { startedAtMs: 0, cwd: '/work/project', permissions: {
        fileSystem: { entries: [{ path: { type: 'path', path: '/work/project/src' }, access: 'write' as const }] }
      } } };
    const onRespond = vi.fn().mockRejectedValueOnce(new Error('Transport failed: internal-request-123')).mockResolvedValue(undefined);
    render(<InteractionPanel interactions={[interaction]} sessions={[]} onRespond={onRespond} />);
    const allow = screen.getByRole('button', { name: 'Grant for turn' });
    fireEvent.click(allow);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('internal-request-123');
    expect(screen.getByText('Write files')).toBeTruthy();
    expect(screen.getByTitle('/work/project/src').textContent).toBe('src');
    expect(screen.getByText('Transport failed: internal-request-123').closest('details')?.open).toBe(false);
    await waitFor(() => expect(allow).toHaveProperty('disabled', false));
    fireEvent.click(allow);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(onRespond).toHaveBeenCalledTimes(2);
    expect(onRespond.mock.lastCall?.[1]).toEqual({ interactionType: 'PERMISSION_APPROVAL', action: 'GRANT_TURN', permissions: interaction.request.permissions });
  });

  it('preserves selected answers while delegating only unresolved Design choices, without changing selection on focus', async () => {
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

    fireEvent.click(screen.getByRole('radio', { name: /New customers/ }));
    const audience = screen.getByRole('group', { name: 'Who is this page for?' });
    const other = within(audience).getByRole('radio', { name: 'Other…' });
    other.focus();
    expect(screen.getByRole('radio', { name: /New customers/ })).toHaveProperty('checked', true);
    fireEvent.click(other);
    expect(screen.getByRole('radio', { name: /New customers/ })).toHaveProperty('checked', false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Audience other answer' }), { target: { value: 'Local partners' } });
    fireEvent.click(screen.getByRole('radio', { name: /New customers/ }));
    expect(screen.queryByRole('textbox', { name: 'Audience other answer' })).toBeNull();
    fireEvent.click(other);
    expect(screen.getByRole('textbox', { name: 'Audience other answer' })).toHaveProperty('value', 'Local partners');
    fireEvent.click(screen.getByRole('radio', { name: /New customers/ }));
    const decide = screen.getByRole('button', { name: 'Decide the rest' });
    fireEvent.click(decide);
    fireEvent.click(decide);

    expect(onRespond).toHaveBeenCalledOnce();
    expect(onRespond).toHaveBeenCalledWith(interaction, {
      interactionType: 'USER_INPUT',
      action: 'ANSWER',
      answers: {
        audience: ['New customers'],
        scope: ['Decide for me']
      }
    });
  });

  it('shows persisted answers during confirmation after remount, without allowing a resend', () => {
    const interaction = userInputInteraction();
    interaction.status = 'RESPONDING';
    interaction.decision = { interactionType: 'USER_INPUT', action: 'ANSWER', answers: { checks: ['Unit', 'Smoke'], detail: ['Keep keyboard support.'] } };
    render(<InteractionPanel interactions={[interaction]} sessions={[]} onRespond={vi.fn()} />);
    expect(screen.getByText('Unit; Smoke')).toBeTruthy();
    expect(screen.getByText('Keep keyboard support.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Confirmation pending');
    expect(screen.queryByRole('button', { name: 'Submit answers' })).toBeNull();
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
