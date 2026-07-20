import { describe, expect, it } from 'vitest';
import type { AgentAssignmentSnapshot } from '../../shared/discourse';
import { discourseExecutionSettings } from './DiscourseContextSnapshotService';

describe('discourseExecutionSettings', () => {
  it('does not reinterpret a runtime identity fallback as an explicit model provider', () => {
    expect(discourseExecutionSettings(assignment({
      runtimeId: 'codex',
      modelProvider: 'codex'
    }))).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
      sandbox: 'READ_ONLY',
      networkAccess: false,
      approvalPolicy: 'NEVER',
      approvalsReviewer: 'user'
    });
  });

  it('preserves a provider explicitly reported by the runtime catalog', () => {
    expect(discourseExecutionSettings(assignment({
      runtimeId: 'codex',
      modelProvider: 'azure-openai'
    }))).toMatchObject({
      modelProvider: 'azure-openai',
      sandbox: 'READ_ONLY',
      networkAccess: false,
      approvalPolicy: 'NEVER'
    });
  });
});

function assignment(
  overrides: Pick<AgentAssignmentSnapshot, 'runtimeId' | 'modelProvider'>
): AgentAssignmentSnapshot {
  return {
    stableParticipantId: 'participant-1',
    participantRevisionId: 'participant-revision-1',
    agentProfileId: 'builtin.lead',
    profileRevision: 1,
    displayNameSnapshot: 'Lead',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'low',
    configuredRole: 'LEAD',
    roleContractVersion: 1,
    roleContractHash: 'role-contract-hash',
    assignmentRole: 'PRIMARY',
    required: true,
    ...overrides
  };
}
