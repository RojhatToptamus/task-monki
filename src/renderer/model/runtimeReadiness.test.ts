import { describe, expect, it } from 'vitest';
import type { AgentRuntimeState } from '../../shared/contracts';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import { runtimeReadinessView } from './runtimeReadiness';

describe('runtimeReadinessView', () => {
  it('keeps a discovered on-demand runtime startable without calling it ready', () => {
    const view = runtimeReadinessView(
      state(
        createRuntimeReadiness(
          'DISCOVERED',
          'The executable was found; its live session contract is checked on first use.'
        )
      )
    );

    expect(view).toMatchObject({
      canStart: true,
      label: 'Available to start',
      tone: 'muted',
      optionSuffix: ' (available to start)'
    });
  });

  it('projects warning-severity diagnostics while keeping informational notices out of primary UI', () => {
    const view = runtimeReadinessView(
      state(
        createRuntimeReadiness('DISCOVERED', 'The executable was found.', {
          diagnostics: [
            {
              code: 'PROVIDER_PROCESS_NOT_SANDBOXED',
              severity: 'WARNING',
              stage: 'SECURITY',
              message: 'The provider process is not sandboxed.'
            },
            {
              code: 'ACP_CLIENT_TOOLS_DISABLED',
              severity: 'INFO',
              stage: 'SECURITY',
              message: 'No ACP client tools are exposed.'
            },
            {
              code: 'PROVIDER_AUTHENTICATION_MANAGED',
              severity: 'INFO',
              stage: 'AUTHENTICATION',
              message: 'Authentication remains provider-managed.'
            }
          ]
        })
      )
    );

    expect(view.warnings.map((diagnostic) => diagnostic.code)).toEqual([
      'PROVIDER_PROCESS_NOT_SANDBOXED'
    ]);
    expect(view.diagnostics).toHaveLength(3);
  });

  it('surfaces an authentication action without parsing diagnostic prose', () => {
    const view = runtimeReadinessView(
      state(
        createRuntimeReadiness(
          'AUTHENTICATION_REQUIRED',
          'Sign in before starting a task.',
          {
            nextAction: { kind: 'AUTHENTICATE', label: 'Sign in to provider' }
          }
        )
      )
    );

    expect(view).toMatchObject({
      canStart: false,
      label: 'Sign in required',
      detail: 'Sign in before starting a task.',
      tone: 'error',
      nextAction: 'Sign in to provider'
    });
  });

  it('keeps an unsupported security boundary blocked and actionable', () => {
    const view = runtimeReadinessView(
      state(
        createRuntimeReadiness(
          'UNSUPPORTED_SECURITY_POLICY',
          'This runtime cannot attest browser-development isolation.',
          {
            nextAction: { kind: 'VIEW_DETAILS', label: 'Review security limits' }
          }
        )
      )
    );

    expect(view).toMatchObject({
      canStart: false,
      label: 'Security policy unsupported',
      tone: 'error',
      nextAction: 'Review security limits'
    });
  });

  it('reserves Disabled for the settings switch instead of runtime availability', () => {
    const view = runtimeReadinessView(
      state(createRuntimeReadiness('DISABLED', 'The runtime is disabled in Settings.'))
    );

    expect(view).toMatchObject({
      canStart: false,
      label: 'Unavailable',
      optionSuffix: ' (unavailable)'
    });
  });
});

function state(
  readiness: AgentRuntimeState['preflight']['readiness']
): AgentRuntimeState {
  return {
    preflight: {
      runtime: {
        id: 'test',
        displayName: 'Test',
        kind: 'ACP_AGENT',
        transport: 'IN_PROCESS',
        lifecycleScope: 'APPLICATION'
      },
      readiness,
      capabilities: {
        runtimeId: 'test',
        executionPolicy: {
          defaultPresetId: 'test',
          presets: [
            {
              id: 'test',
              label: 'Test',
              detail: 'Test',
              sandbox: 'READ_ONLY',
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              networkAccess: 'DISABLED'
            }
          ],
          detail: 'Test'
        },
        promptRefinement: { maturity: 'unsupported' },
        modelCatalog: { maturity: 'unsupported' },
        reasoningEffort: { maturity: 'unsupported' },
        persistentSessions: { maturity: 'unsupported' },
        sessionResume: { maturity: 'unsupported' },
        sessionFork: { maturity: 'unsupported' },
        activeTurnSteering: { maturity: 'unsupported' },
        turnInterruption: { maturity: 'unsupported' },
        truePause: { maturity: 'unsupported' },
        interactiveApprovals: { maturity: 'unsupported' },
        userInputRequests: { maturity: 'unsupported' },
        goals: { maturity: 'unsupported' },
        plans: { maturity: 'unsupported' },
        detachedReview: { maturity: 'unsupported' },
        review: { maturity: 'unsupported' },
        subagents: { maturity: 'unsupported' },
        backgroundTerminals: { maturity: 'unsupported' },
        dynamicTools: { maturity: 'unsupported' },
        attachmentDelivery: { maturity: 'unsupported' },
        runtimeRecovery: { maturity: 'unsupported' },
        extensions: {}
      }
    },
    models: [],
    refreshedAt: new Date(0).toISOString()
  };
}
