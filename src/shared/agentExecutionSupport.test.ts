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
        model: {
          inputModalities: ['text', 'image'],
          designSupport: { maturity: 'stable' }
        }
      })
    ).toEqual({ supported: true });
  });

  it('uses the shared read-only policy for review without coupling it to the source runtime', () => {
    const capabilities = supportedCapabilities({
      detachedReview: { maturity: 'unsupported' }
    });

    expect(projectAgentExecutionSupport(capabilities, 'REVIEW')).toEqual({
      supported: true
    });
  });

  it('explains the exact unqualified read-only profile without disabling normal Tasks', () => {
    const capabilities = supportedCapabilities({
      executionPolicy: {
        defaultPresetId: 'write',
        detail: 'Write access only.',
        presets: [
          {
            id: 'write',
            label: 'Write',
            detail: 'Write access.',
            sandbox: 'WORKSPACE_WRITE',
            repositoryMutation: 'ALLOW',
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            networkAccess: 'DISABLED'
          }
        ]
      },
      promptRefinement: {
        maturity: 'unsupported',
        detail: 'This profile cannot deny shell changes during refinement.'
      },
      detachedReview: {
        maturity: 'unsupported',
        detail: 'This profile has not passed the review mutation test.'
      },
      extensions: {
        'task-monki.read-only-turn': {
          maturity: 'unsupported',
          detail: 'This profile can still mutate through child agents.'
        }
      }
    });

    expect(projectAgentExecutionSupport(capabilities, 'PROMPT_REFINEMENT')).toEqual({
      supported: false,
      reason:
        'This profile cannot deny shell changes during refinement. Normal Tasks remain available.'
    });
    expect(projectAgentExecutionSupport(capabilities, 'REVIEW')).toEqual({
      supported: false,
      reason:
        'This profile has not passed the review mutation test. Normal Tasks remain available.'
    });
    expect(projectAgentExecutionSupport(capabilities, 'DISCOURSE')).toEqual({
      supported: false,
      reason:
        'This profile can still mutate through child agents. Normal Tasks remain available.'
    });
  });

  it('requires the complete current Design and Discourse contracts', () => {
    const capabilities = supportedCapabilities();

    expect(
      projectAgentExecutionSupport(capabilities, 'DESIGN', {
        model: {
          inputModalities: ['text'],
          designSupport: { maturity: 'stable' }
        }
      }).supported
    ).toBe(false);
    expect(
      projectAgentExecutionSupport(capabilities, 'DESIGN', {
        model: {
          inputModalities: ['text', 'image'],
          designSupport: {
            maturity: 'unsupported',
            detail: 'This exact model has not passed Design qualification.'
          }
        }
      })
    ).toEqual({
      supported: false,
      reason: 'This exact model has not passed Design qualification.'
    });
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
            defaultPresetId: 'read-only',
            detail: 'Read-only execution only.',
            presets: [
              {
                id: 'read-only',
                label: 'Read only',
                detail: 'Read-only execution.',
                sandbox: 'READ_ONLY',
                repositoryMutation: 'DENY',
                approvalPolicy: 'never',
                approvalsReviewer: 'user',
                networkAccess: 'DISABLED'
              }
            ]
          }
        }),
        'DESIGN'
      )
    ).toEqual({
      supported: false,
      reason: 'This agent has no approval-free write policy for autonomous Design work.'
    });
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
                repositoryMutation: 'ALLOW',
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
          repositoryMutation: 'DENY',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          networkAccess: 'DISABLED'
        },
        {
          id: 'write',
          label: 'Write',
          detail: 'Autonomous write access.',
          sandbox: 'WORKSPACE_WRITE',
          repositoryMutation: 'ALLOW',
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
      'task-monki.design-instructions': stable,
      'task-monki.design-skill-access': stable,
      'task-monki.design-browser-verification': stable
    },
    ...overrides
  };
}
