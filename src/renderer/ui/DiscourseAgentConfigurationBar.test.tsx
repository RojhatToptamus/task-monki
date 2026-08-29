import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../../core/agent/codex/codexCapabilities';
import type { AgentModel, AgentRuntimeState } from '../../shared/contracts';
import type { DiscourseMentionCatalogSnapshot } from '../../shared/discourse';
import { DiscourseAgentConfigurationBar } from './DiscourseAgentConfigurationBar';

describe('DiscourseAgentConfigurationBar', () => {
  it('shows an unqualified provider with its disabled read-only reason', () => {
    const codexModel = model('codex', 'codex:model', 'Codex model');
    const blockedModel = model('blocked', 'blocked:model', 'Blocked model');
    const blockedRuntime: AgentRuntimeState = {
      preflight: {
        runtime: {
          id: 'blocked',
          displayName: 'Blocked provider',
          kind: 'ACP_AGENT',
          transport: 'STDIO',
          lifecycleScope: 'APPLICATION'
        },
        readiness: createRuntimeReadiness('READY', 'Ready'),
        capabilities: {
          ...codexCapabilities(),
          runtimeId: 'blocked',
          executionPolicy: {
            defaultPresetId: 'write',
            detail: 'Write access only.',
            presets: [
              {
                id: 'write',
                label: 'Write',
                detail: 'Write access.',
                sandbox: 'DANGER_FULL_ACCESS',
                repositoryMutation: 'ALLOW',
                approvalPolicy: 'never',
                approvalsReviewer: 'user',
                networkAccess: 'REQUIRED'
              }
            ]
          },
          detachedReview: {
            maturity: 'unsupported',
            detail: 'This provider can still mutate through child agents.'
          }
        }
      },
      models: [blockedModel],
      refreshedAt: '2026-08-29T00:00:00.000Z'
    };
    const catalog: DiscourseMentionCatalogSnapshot = {
      agents: [
        {
          profile: {
            id: 'builtin.lead',
            displayName: 'Lead',
            roleTemplate: 'LEAD',
            defaultModelPolicy: 'APP_DEFAULT_OR_PROVIDER_DEFAULT',
            defaultReasoningPolicy: 'APP_DEFAULT_OR_MODEL_DEFAULT',
            roleContractVersion: 3,
            revision: 1
          },
          availability: 'AVAILABLE',
          resolvedSettings: {
            runtimeId: 'codex',
            modelId: codexModel.id,
            model: codexModel.model,
            modelProvider: codexModel.modelProvider!
          }
        }
      ],
      runtimeCatalog: {
        defaultRuntimeId: 'codex',
        runtimes: [
          {
            preflight: {
              runtime: CODEX_RUNTIME_DESCRIPTOR,
              readiness: createRuntimeReadiness('READY', 'Ready'),
              capabilities: codexCapabilities()
            },
            models: [codexModel],
            refreshedAt: '2026-08-29T00:00:00.000Z'
          },
          blockedRuntime
        ],
        models: [codexModel, blockedModel],
        refreshedAt: '2026-08-29T00:00:00.000Z'
      },
      tasks: [],
      repositories: [],
      refreshedAt: '2026-08-29T00:00:00.000Z'
    };

    const html = renderToStaticMarkup(
      <DiscourseAgentConfigurationBar
        catalog={catalog}
        compact={false}
        disabled={false}
        expanded
        policy="DIRECT"
        selections={[
          {
            agentProfileId: 'builtin.lead',
            runtimeId: 'codex',
            modelId: codexModel.id
          }
        ]}
        selectedProfileIds={['builtin.lead']}
        onDiscoverModels={async () => undefined}
        onExpandedChange={() => undefined}
        onToggleAgent={() => undefined}
        onSelectionChange={() => undefined}
      />
    );

    expect(html).toContain(
      'This provider can still mutate through child agents. Normal Tasks remain available.'
    );
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*><span>Blocked model<\/span>/u
    );
  });
});

function model(runtimeId: string, id: string, displayName: string): AgentModel {
  return {
    id,
    runtimeId,
    modelProvider: runtimeId,
    model: 'model',
    displayName,
    hidden: false,
    supportedReasoningEfforts: [],
    serviceTiers: [],
    inputModalities: ['text'],
    isDefault: true
  };
}
