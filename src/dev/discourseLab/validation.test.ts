import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateLabInputs } from './validation';

describe('Discourse Lab sealed inputs', () => {
  it('verifies every sealed fixture and decision-changing preregistration', async () => {
    const result = await validateLabInputs(
      path.join(process.cwd(), 'evaluation', 'discourse-lab')
    );
    expect(result.valid).toBe(true);
    expect(result.sealVersion).toBe('text-lab-seal-v8');
    expect(result.preregistrationVersion).toBe('text-lab-prereg-v8');
    expect(result.verifiedFiles).toHaveLength(7);
    expect(result.preregisteredExperimentIds).toEqual([
      'H0',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'H7'
    ]);
    expect(result.executableProtocolConditionIds).toEqual(
      expect.arrayContaining([
        'STRONG_SINGLE_B6',
        'SELF_REVIEW_B3',
        'BLIND_INDEPENDENT_B6',
        'MAP_ONLY_B3',
        'ABC_B5',
        'SAME_C_AUDIT_B6',
        'RECONSTRUCTED_C_AUDIT_B6',
        'FRESH_D_AUDIT_B6',
        'DIRECT_EXCHANGE_B5',
        'CURRENT_TEAM_B5',
        'YOKED_SINGLE_B6'
      ])
    );
    expect(result.nonExecutableProtocolConditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conditionId: 'ABC_STOP_CHARGED_PREFIX_B6',
          preregisteredLabel: 'ABC_STOP_CHARGED_PREFIX@B6',
          executionStatus: 'REQUIRES_FROZEN_PREFIX_REPLAY'
        }),
        expect.objectContaining({
          conditionId: 'AUDIT_TARGETED_RERESPONSE_FINAL_SCOPED_AUDIT_B8',
          executionStatus: 'DEFERRED_PREREG_ONLY'
        }),
        expect.objectContaining({
          conditionId: 'STRONG_SINGLE_B8',
          executionStatus: 'DEFERRED_PREREG_ONLY'
        }),
        expect.objectContaining({
          conditionId: 'YOKED_SINGLE_B8',
          executionStatus: 'DEFERRED_PREREG_ONLY'
        })
      ])
    );
  });
});
