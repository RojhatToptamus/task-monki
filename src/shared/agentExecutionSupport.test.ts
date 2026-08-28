import { describe, expect, it } from 'vitest';
import type { AgentRuntimeCapabilities } from './agent';
import { projectAgentExecutionSupport } from './agentExecutionSupport';

describe('projectAgentExecutionSupport', () => {
  it('keeps current workflow support in one provider-neutral projection', () => {
    const capabilities = supportedCapabilities();

    expect(projectAgentExecutionSupport(capabilities, 'ACTIVE_TURN_STEERING')).toEqual({
      supported: true
    });
    expect(projectAgentExecutionSupport(capabilities, 'PROMPT_REFINEMENT')).toEqual({
      supported: true
    });
    expect(projectAgentExecutionSupport(capabilities, 'DISCOURSE')).toEqual({
      supported: true
    });
    expect(
      projectAgentExecutionSupport(capabilities, 'DESIGN', {
        model: { inputModalities: ['text', 'image'] }
      })
    ).toEqual({ supported: true });
  });

  it('does not treat native review as a cross-runtime review operation', () => {
    const capabilities = supportedCapabilities({
      detachedReview: { maturity: 'unsupported' }
    });

    expect(
      projectAgentExecutionSupport(capabilities, 'REVIEW', {
        sourceRuntimeId: capabilities.runtimeId
      }).supported
    ).toBe(true);
    expect(
      projectAgentExecutionSupport(capabilities, 'REVIEW', {
        sourceRuntimeId: 'another-runtime'
      }).supported
    ).toBe(false);
  });

  it('requires the complete current Design and Discourse contracts', () => {
    const capabilities = supportedCapabilities();

    expect(
      projectAgentExecutionSupport(capabilities, 'DESIGN', {
        model: { inputModalities: ['text'] }
      }).supported
    ).toBe(false);
    expect(
      projectAgentExecutionSupport(
        supportedCapabilities({ attachmentDelivery: { maturity: 'unsupported' } }),
        'DESIGN'
      ).supported
    ).toBe(false);
    expect(
      projectAgentExecutionSupport(
        supportedCapabilities({
          executionPolicy: {
            defaultPresetId: 'write',
            detail: 'Write access only.',
            presets: [
              {
                id: 'write',
                label: 'Write',
                detail: 'Write access.',
                sandbox: 'WORKSPACE_WRITE',
                approvalPolicy: 'never',
                approvalsReviewer: 'user',
                networkAccess: 'DISABLED'
              }
            ]
          }
        }),
        'DISCOURSE'
      ).supported
    ).toBe(false);
  });
});

function supportedCapabilities(
  overrides: Partial<AgentRuntimeCapabilities> = {}
): AgentRuntimeCapabilities {
  const stable = { maturity: 'stable' as const };
  return {
    runtimeId: 'runtime',
    executionPolicy: {
      defaultPresetId: 'read-only',
      detail: 'Read-only execution.',
      presets: [
        {
          id: 'read-only',
          label: 'Read only',
          detail: 'Read-only execution.',
          sandbox: 'READ_ONLY',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          networkAccess: 'DISABLED'
        }
      ]
    },
    promptRefinement: stable,
    modelCatalog: stable,
    reasoningEffort: stable,
    persistentSessions: stable,
    sessionResume: stable,
    sessionFork: stable,
    activeTurnSteering: stable,
    turnInterruption: stable,
    truePause: { maturity: 'unsupported' },
    interactiveApprovals: stable,
    userInputRequests: stable,
    goals: stable,
    plans: stable,
    detachedReview: stable,
    review: stable,
    subagents: { maturity: 'unsupported' },
    backgroundTerminals: { maturity: 'unsupported' },
    dynamicTools: stable,
    attachmentDelivery: stable,
    runtimeRecovery: stable,
    extensions: {
      'task-monki.discourse': stable,
      'task-monki.design-instructions': stable,
      'task-monki.design-skill-access': stable,
      'task-monki.design-browser-verification': stable
    },
    ...overrides
  };
}
