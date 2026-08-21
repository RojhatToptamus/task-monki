import { describe, expect, it } from 'vitest';
import {
  assertFiniteProtocolPlan,
  getLabProtocolPlan,
  listLabConditionDeclarations,
  listLabProtocolPlans
} from './protocols';

describe('Discourse Protocol Lab finite plans', () => {
  it('defines every requested condition with bounded calls, rounds, and output', () => {
    const plans = listLabProtocolPlans();
    expect(plans.map((plan) => plan.conditionId)).toEqual(
      expect.arrayContaining([
        'STRONG_SINGLE_B3',
        'STRONG_SINGLE_B5',
        'STRONG_SINGLE_B6',
        'SELF_REVIEW_B3',
        'SELF_REVIEW_B5',
        'BLIND_INDEPENDENT_B3',
        'BLIND_INDEPENDENT_B5',
        'BLIND_INDEPENDENT_B6',
        'MAP_ONLY_B3',
        'CURRENT_TEAM_B5',
        'ABC_B5',
        'SAME_C_AUDIT_B6',
        'RECONSTRUCTED_C_AUDIT_B6',
        'FRESH_D_AUDIT_B6',
        'DIRECT_EXCHANGE_B5',
        'YOKED_SINGLE_B6',
        'CONTROL_CASE_ONLY_B1',
        'CONTROL_VALID_CRITIQUE_B1',
        'CONTROL_EVIDENCE_B1',
        'CONTROL_INVALID_CRITIQUE_B1'
      ])
    );
    expect(plans).toHaveLength(23);
    plans.forEach(assertFiniteProtocolPlan);
  });

  it('keeps the H1b case-only reference to one fresh case-only position call', () => {
    expect(getLabProtocolPlan('CONTROL_CASE_ONLY_B1')).toMatchObject({
      hypothesisIds: ['H1b'],
      maximumCalls: 1,
      maximumRounds: 0,
      terminalArtifacts: ['response'],
      calls: [{
        id: 'response',
        actor: 'SINGLE',
        promptKind: 'POSITION',
        visible: ['CASE'],
        maxOutputTokens: 900
      }]
    });
  });

  it('models the three audit identities without conflating session continuity', () => {
    const same = getLabProtocolPlan('SAME_C_AUDIT_B6').calls.at(-1);
    const reconstructed = getLabProtocolPlan('RECONSTRUCTED_C_AUDIT_B6').calls.at(-1);
    const fresh = getLabProtocolPlan('FRESH_D_AUDIT_B6').calls.at(-1);
    expect(same).toMatchObject({ actor: 'C', continueFrom: 'C' });
    expect(reconstructed).toMatchObject({ actor: 'C' });
    expect(reconstructed).not.toHaveProperty('continueFrom');
    expect(fresh).toMatchObject({ actor: 'D' });
    expect(fresh).not.toHaveProperty('continueFrom');
  });

  it('keeps every H4 audit prefix structurally identical to the frozen ABC prefix', () => {
    const abc = getLabProtocolPlan('ABC_B5');
    for (const conditionId of [
      'SAME_C_AUDIT_B6',
      'RECONSTRUCTED_C_AUDIT_B6',
      'FRESH_D_AUDIT_B6'
    ] as const) {
      const audit = getLabProtocolPlan(conditionId);
      expect(audit.calls.slice(0, abc.calls.length)).toEqual(abc.calls);
    }
  });

  it('declares replay-only and H6 B8 arms without making them executable', () => {
    const declared = new Map(
      listLabConditionDeclarations().map((condition) => [condition.conditionId, condition])
    );
    expect(declared.get('ABC_STOP_CHARGED_PREFIX_B6')).toMatchObject({
      executionStatus: 'REQUIRES_FROZEN_PREFIX_REPLAY',
      hypothesisIds: ['H4'],
      budgetTier: 'B6',
      prefixSourceConditionId: 'ABC_B5',
      chargedUpstreamCallIds: ['A', 'B', 'C', 'A_RESPONSE', 'B_RESPONSE']
    });
    for (const conditionId of [
      'BEST_H4_AUDIT_STOP_B6',
      'AUDIT_TARGETED_RERESPONSE_FINAL_SCOPED_AUDIT_B8',
      'STRONG_SINGLE_B8',
      'YOKED_SINGLE_B8'
    ] as const) {
      expect(declared.get(conditionId)).toMatchObject({
        executionStatus: 'DEFERRED_PREREG_ONLY',
        hypothesisIds: ['H6']
      });
      expect(() => getLabProtocolPlan(conditionId)).toThrow('is not executable');
    }
    const forgedDeferredPlan = {
      ...getLabProtocolPlan('ABC_B5'),
      conditionId: 'ABC_STOP_CHARGED_PREFIX_B6' as never
    };
    expect(() => assertFiniteProtocolPlan(forgedDeferredPlan)).toThrow(
      'declared but not executable'
    );
    expect(getLabProtocolPlan('YOKED_SINGLE_B6').hypothesisIds).toEqual(['H7']);
  });

  it('freezes blind answers and direct responses before sibling visibility', () => {
    const direct = getLabProtocolPlan('DIRECT_EXCHANGE_B5');
    expect(direct.calls.slice(0, 2).map((call) => call.blindGroup)).toEqual([
      'blind-positions',
      'blind-positions'
    ]);
    expect(direct.calls.slice(2, 4).map((call) => call.blindGroup)).toEqual([
      'direct-responses',
      'direct-responses'
    ]);
  });

  it('keeps the self-review baselines on one stable identity and matches B3/B5 controls', () => {
    for (const conditionId of ['SELF_REVIEW_B3', 'SELF_REVIEW_B5'] as const) {
      const plan = getLabProtocolPlan(conditionId);
      expect(new Set(plan.calls.map((call) => call.actor))).toEqual(new Set(['SINGLE']));
      expect(plan.calls.slice(1).every((call) => Boolean(call.continueFrom))).toBe(true);
    }
    for (const tier of [3, 5] as const) {
      expect(getLabProtocolPlan(`STRONG_SINGLE_B${tier}` as const).maximumOutputTokens).toBe(
        tier * 900
      );
      expect(getLabProtocolPlan(`BLIND_INDEPENDENT_B${tier}` as const).maximumOutputTokens).toBe(
        tier * 900
      );
    }
  });
});
