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
    expect(
      projectAgentExecutionSupport(capabilities, 'PREVIEW_RECIPE_GENERATION')
    ).toEqual({ supported: true });
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

  it('keeps every runtime available for shared read-only workflows', () => {
    const capabilities = supportedCapabilities({
      readOnlyTurns: {
        maturity: 'unsupported',
        detail: 'This profile can still mutate through child agents.'
      }
    });

    for (const operation of [
      'PROMPT_REFINEMENT',
      'REVIEW',
      'DISCOURSE'
    ] as const) {
      expect(projectAgentExecutionSupport(capabilities, operation)).toEqual({
        supported: true
      });
    }
  });

  it('does not use runtime or model allowlists for Preview generation', () => {
    const capabilities = supportedCapabilities({
      readOnlyTurns: {
        maturity: 'unsupported',
        detail: 'This profile can still mutate a repository.'
      },
      extensions: {
        ...supportedCapabilities().extensions,
        'task-monki.preview-recipe-generation': { maturity: 'stable' }
      }
    });

    expect(
      projectAgentExecutionSupport(capabilities, 'PREVIEW_RECIPE_GENERATION')
    ).toEqual({ supported: true });
    expect(
      projectAgentExecutionSupport(capabilities, 'PREVIEW_RECIPE_GENERATION', {
        model: {
          inputModalities: ['text']
        }
      })
    ).toEqual({ supported: true });
    expect(projectAgentExecutionSupport(capabilities, 'REVIEW')).toEqual({
      supported: true
    });
  });

  it('requires the complete current Design contract and uses the read-only turn capability for Discourse', () => {
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
            detail: 'This model does not report the required Design capabilities.'
          }
        }
      })
    ).toEqual({
      supported: false,
      reason: 'This model does not report the required Design capabilities.'
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
      )
    ).toEqual({ supported: true });
  });

  it('lets the explicit qualification harness bypass only candidate model and image gates', () => {
    const candidateModel = {
      inputModalities: ['text'],
      designSupport: {
        maturity: 'unsupported' as const,
        detail: 'This candidate does not report the required Design capabilities.'
      }
    };

    expect(
      projectAgentExecutionSupport(supportedCapabilities(), 'DESIGN', {
        model: candidateModel,
        allowCandidateDesignModel: true
      })
    ).toEqual({ supported: true });
    expect(
      projectAgentExecutionSupport(
        supportedCapabilities({ turnInterruption: { maturity: 'unsupported' } }),
        'DESIGN',
        {
          model: candidateModel,
          allowCandidateDesignModel: true
        }
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
    readOnlyTurns: stable,
    modelCatalog: stable,
    activeTurnSteering: stable,
    turnInterruption: stable,
    attachmentDelivery: stable,
    extensions: {
      'task-monki.design-instructions': stable,
      'task-monki.design-skill-access': stable,
      'task-monki.design-browser-verification': stable
    },
    ...overrides
  };
}
