export const LAB_PROTOCOL_VERSION = 'text-protocols@v4' as const;

export type LabConditionId =
  | 'STRONG_SINGLE_B3'
  | 'STRONG_SINGLE_B5'
  | 'STRONG_SINGLE_B6'
  | 'SELF_REVIEW_B3'
  | 'SELF_REVIEW_B5'
  | 'BLIND_INDEPENDENT_B3'
  | 'BLIND_INDEPENDENT_B5'
  | 'BLIND_INDEPENDENT_B6'
  | 'MAP_ONLY_B3'
  | 'CURRENT_TEAM_B5'
  | 'ABC_B5'
  | 'SAME_C_AUDIT_B6'
  | 'RECONSTRUCTED_C_AUDIT_B6'
  | 'FRESH_D_AUDIT_B6'
  | 'DIRECT_EXCHANGE_B5'
  | 'YOKED_SINGLE_B6'
  | 'CONTROL_CASE_ONLY_B1'
  | 'CONTROL_NO_FEEDBACK_B1'
  | 'CONTROL_VALID_CRITIQUE_B1'
  | 'CONTROL_EVIDENCE_B1'
  | 'CONTROL_INVALID_CRITIQUE_B1'
  | 'CONTROL_CONFIDENT_WRONG_B1'
  | 'CONTROL_CORRECT_MINORITY_B1';

/**
 * Conditions named by the preregistration but intentionally unavailable to
 * the full-live runner. Keeping these ids out of LabConditionId prevents a
 * gated or replay-only arm from being mistaken for an executable protocol.
 */
export type LabNonExecutableConditionId =
  | 'ABC_STOP_CHARGED_PREFIX_B6'
  | 'BEST_H4_AUDIT_STOP_B6'
  | 'AUDIT_TARGETED_RERESPONSE_FINAL_SCOPED_AUDIT_B8'
  | 'STRONG_SINGLE_B8'
  | 'YOKED_SINGLE_B8';

export type LabDeclaredConditionId = LabConditionId | LabNonExecutableConditionId;

export interface LabConditionDeclaration {
  conditionId: LabDeclaredConditionId;
  preregisteredLabel: string;
  executionStatus:
    | 'EXECUTABLE_FULL_LIVE'
    | 'REQUIRES_FROZEN_PREFIX_REPLAY'
    | 'DEFERRED_PREREG_ONLY';
  hypothesisIds: readonly string[];
  budgetTier: 'B1' | 'B3' | 'B5' | 'B6' | 'B8';
  reason: string;
  prefixSourceConditionId?: LabConditionId;
  chargedUpstreamCallIds?: readonly string[];
}

export type LabPromptKind =
  | 'POSITION'
  | 'SINGLE_CHALLENGE'
  | 'SINGLE_EVIDENCE_AUDIT'
  | 'SINGLE_ALTERNATIVES'
  | 'SINGLE_RESOLVE'
  | 'SINGLE_FINAL'
  | 'SELF_AUDIT'
  | 'SELF_REVISE'
  | 'MAP'
  | 'CURRENT_REVIEW'
  | 'CURRENT_CORRECTION'
  | 'ISSUE_RESPONSE'
  | 'AUDIT'
  | 'DIRECT_RESPONSE'
  | 'CONTROLLED_RESPONSE';

export type LabVisibilityRef =
  | 'CASE'
  | 'INTERVENTION'
  | 'A'
  | 'B'
  | 'C'
  | 'A_RESPONSE'
  | 'B_RESPONSE'
  | 'REVIEW_1'
  | 'REVIEW_2'
  | 'PRIOR_SELF';

export interface LabProtocolCall {
  id: string;
  actor: 'SINGLE' | 'A' | 'B' | 'C' | 'D' | 'REVIEWER_1' | 'REVIEWER_2';
  promptKind: LabPromptKind;
  /** Calls in the same blind group are submitted before any sibling output is visible. */
  blindGroup?: string;
  /** Continue the exact provider thread created by this earlier call. */
  continueFrom?: string;
  visible: readonly LabVisibilityRef[];
  maxOutputTokens: number;
}

export interface LabProtocolPlan {
  version: typeof LAB_PROTOCOL_VERSION;
  conditionId: LabConditionId;
  hypothesisIds: readonly string[];
  description: string;
  calls: readonly LabProtocolCall[];
  maximumCalls: number;
  maximumRounds: number;
  maximumOutputTokens: number;
  comparableBudgetTier: 'B1' | 'B3' | 'B5' | 'B6';
  terminalArtifacts: readonly string[];
}

const B1 = 900;

function plan(
  conditionId: LabConditionId,
  hypothesisIds: readonly string[],
  description: string,
  calls: readonly Omit<LabProtocolCall, 'maxOutputTokens'>[],
  maximumRounds: number,
  terminalArtifacts: readonly string[],
  budgetTier?: LabProtocolPlan['comparableBudgetTier']
): LabProtocolPlan {
  const tier = budgetTier ?? (`B${calls.length}` as LabProtocolPlan['comparableBudgetTier']);
  const totalCeiling = Number(tier.slice(1)) * B1;
  const extra = totalCeiling - calls.length * B1;
  if (extra < 0) throw new Error(`${conditionId} exceeds its declared budget tier.`);
  const withBudgets = calls.map((call, index) => ({
    ...call,
    maxOutputTokens:
      B1 +
      (index === 0 ? Math.ceil(extra / 2) : 0) +
      (index === calls.length - 1 ? Math.floor(extra / 2) : 0)
  }));
  return {
    version: LAB_PROTOCOL_VERSION,
    conditionId,
    hypothesisIds,
    description,
    calls: withBudgets,
    maximumCalls: calls.length,
    maximumRounds,
    maximumOutputTokens: totalCeiling,
    comparableBudgetTier: tier,
    terminalArtifacts
  };
}

const PLANS: Record<LabConditionId, LabProtocolPlan> = {
  STRONG_SINGLE_B3: singleWorkbench('STRONG_SINGLE_B3', 3, ['H2', 'H7']),
  STRONG_SINGLE_B5: singleWorkbench('STRONG_SINGLE_B5', 5, ['H3', 'H5', 'H7']),
  STRONG_SINGLE_B6: singleWorkbench('STRONG_SINGLE_B6', 6, ['H4', 'H7']),
  SELF_REVIEW_B3: plan(
    'SELF_REVIEW_B3',
    ['H7'],
    'One stable identity drafts, audits its own public answer in the same thread, then makes an attributable revision.',
    [
      { id: 'A', actor: 'SINGLE', promptKind: 'POSITION', visible: ['CASE'] },
      { id: 'self-audit', actor: 'SINGLE', promptKind: 'SELF_AUDIT', continueFrom: 'A', visible: ['CASE', 'PRIOR_SELF'] },
      { id: 'A_RESPONSE', actor: 'SINGLE', promptKind: 'SELF_REVISE', continueFrom: 'self-audit', visible: ['CASE', 'PRIOR_SELF'] }
    ],
    1,
    ['A_RESPONSE']
  ),
  SELF_REVIEW_B5: plan(
    'SELF_REVIEW_B5',
    ['H3', 'H5', 'H7'],
    'One stable identity drafts, challenges itself, checks evidence, revises, and emits a final answer without peer framing.',
    [
      { id: 'self-1', actor: 'SINGLE', promptKind: 'POSITION', visible: ['CASE'] },
      { id: 'self-2', actor: 'SINGLE', promptKind: 'SELF_AUDIT', continueFrom: 'self-1', visible: ['CASE', 'PRIOR_SELF'] },
      { id: 'self-3', actor: 'SINGLE', promptKind: 'SINGLE_EVIDENCE_AUDIT', continueFrom: 'self-2', visible: ['CASE', 'PRIOR_SELF'] },
      { id: 'self-4', actor: 'SINGLE', promptKind: 'SELF_REVISE', continueFrom: 'self-3', visible: ['CASE', 'PRIOR_SELF'] },
      { id: 'self-5', actor: 'SINGLE', promptKind: 'SINGLE_FINAL', continueFrom: 'self-4', visible: ['CASE', 'PRIOR_SELF'] }
    ],
    1,
    ['self-5']
  ),
  BLIND_INDEPENDENT_B3: plan(
    'BLIND_INDEPENDENT_B3',
    ['H2', 'H7'],
    'Three fresh answers are frozen before any answer becomes visible to another actor; no semantic integrator is added.',
    [
      { id: 'A', actor: 'A', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] },
      { id: 'B', actor: 'B', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] },
      { id: 'C', actor: 'C', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] }
    ],
    0,
    ['A', 'B', 'C']
  ),
  BLIND_INDEPENDENT_B6: plan(
    'BLIND_INDEPENDENT_B6',
    ['H4', 'H7'],
    'Six fresh sealed answers at the B6 ceiling with no discussion or semantic integrator.',
    Array.from({ length: 6 }, (_, index) => ({
      id: `sample-${index + 1}`,
      actor: (index % 2 === 0 ? 'A' : 'B') as LabProtocolCall['actor'],
      promptKind: 'POSITION' as const,
      blindGroup: 'blind-positions',
      visible: ['CASE'] as const
    })),
    0,
    ['sample-1', 'sample-2', 'sample-3', 'sample-4', 'sample-5', 'sample-6']
  ),
  BLIND_INDEPENDENT_B5: plan(
    'BLIND_INDEPENDENT_B5',
    ['H3', 'H5', 'H7'],
    'Five fresh sealed answers at the B5 ceiling with no discussion or semantic integrator.',
    Array.from({ length: 5 }, (_, index) => ({
      id: `sample-${index + 1}`,
      actor: (index % 2 === 0 ? 'A' : 'B') as LabProtocolCall['actor'],
      promptKind: 'POSITION' as const,
      blindGroup: 'blind-positions',
      visible: ['CASE'] as const
    })),
    0,
    ['sample-1', 'sample-2', 'sample-3', 'sample-4', 'sample-5']
  ),
  MAP_ONLY_B3: plan(
    'MAP_ONLY_B3',
    ['H2'],
    'Two blind positions are followed by one neutral claim-level map; authors cannot revise.',
    [
      { id: 'A', actor: 'A', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] },
      { id: 'B', actor: 'B', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] },
      { id: 'C', actor: 'C', promptKind: 'MAP', visible: ['CASE', 'A', 'B'] }
    ],
    0,
    ['C']
  ),
  CURRENT_TEAM_B5: plan(
    'CURRENT_TEAM_B5',
    ['H7'],
    'Frozen approximation of current Lead answer, two isolated role-framed reviews, and one Lead correction.',
    [
      { id: 'A', actor: 'A', promptKind: 'POSITION', visible: ['CASE'] },
      { id: 'review-1', actor: 'REVIEWER_1', promptKind: 'CURRENT_REVIEW', blindGroup: 'current-reviews', visible: ['CASE', 'A'] },
      { id: 'review-2', actor: 'REVIEWER_2', promptKind: 'CURRENT_REVIEW', blindGroup: 'current-reviews', visible: ['CASE', 'A'] },
      { id: 'A_RESPONSE', actor: 'A', promptKind: 'CURRENT_CORRECTION', continueFrom: 'A', visible: ['CASE', 'A', 'REVIEW_1', 'REVIEW_2'] }
    ],
    1,
    ['A_RESPONSE'],
    'B5'
  ),
  ABC_B5: plan(
    'ABC_B5',
    ['H2', 'H3', 'H7'],
    'Equal blind peers A/B, neutral claim mapper C, then one issue-targeted response from each original author.',
    [
      { id: 'A', actor: 'A', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] },
      { id: 'B', actor: 'B', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] },
      { id: 'C', actor: 'C', promptKind: 'MAP', visible: ['CASE', 'A', 'B'] },
      { id: 'A_RESPONSE', actor: 'A', promptKind: 'ISSUE_RESPONSE', blindGroup: 'author-responses', continueFrom: 'A', visible: ['CASE', 'A', 'C'] },
      { id: 'B_RESPONSE', actor: 'B', promptKind: 'ISSUE_RESPONSE', blindGroup: 'author-responses', continueFrom: 'B', visible: ['CASE', 'B', 'C'] }
    ],
    1,
    ['C', 'A_RESPONSE', 'B_RESPONSE']
  ),
  SAME_C_AUDIT_B6: plan(
    'SAME_C_AUDIT_B6',
    ['H4'],
    'ABC followed by an audit in the exact live C thread, preserving latent session history.',
    abcAuditCalls('C'),
    2,
    ['audit']
  ),
  RECONSTRUCTED_C_AUDIT_B6: plan(
    'RECONSTRUCTED_C_AUDIT_B6',
    ['H4'],
    'ABC followed by a fresh C-framed session reconstructed only from the public trajectory.',
    abcAuditCalls(),
    2,
    ['audit']
  ),
  FRESH_D_AUDIT_B6: plan(
    'FRESH_D_AUDIT_B6',
    ['H4'],
    'ABC followed by a fresh neutral D auditor with the exact public trajectory.',
    abcAuditCalls(undefined, 'D'),
    2,
    ['audit']
  ),
  DIRECT_EXCHANGE_B5: plan(
    'DIRECT_EXCHANGE_B5',
    ['H5', 'H7'],
    'Blind A/B exchange issue-targeted responses directly and a fresh neutral D performs the common terminal audit.',
    [
      { id: 'A', actor: 'A', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] },
      { id: 'B', actor: 'B', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] },
      { id: 'A_RESPONSE', actor: 'A', promptKind: 'DIRECT_RESPONSE', blindGroup: 'direct-responses', continueFrom: 'A', visible: ['CASE', 'A', 'B'] },
      { id: 'B_RESPONSE', actor: 'B', promptKind: 'DIRECT_RESPONSE', blindGroup: 'direct-responses', continueFrom: 'B', visible: ['CASE', 'A', 'B'] },
      { id: 'C', actor: 'C', promptKind: 'MAP', visible: ['CASE', 'A', 'B', 'A_RESPONSE', 'B_RESPONSE'] }
    ],
    2,
    ['C'],
    'B5'
  ),
  YOKED_SINGLE_B6: plan(
    'YOKED_SINGLE_B6',
    ['H7'],
    'One stable identity follows the six-call ABC-audit schedule without peer, role, authority, or majority framing.',
    [
      { id: 'yoked-1', actor: 'SINGLE', promptKind: 'POSITION', visible: ['CASE'] },
      { id: 'yoked-2', actor: 'SINGLE', promptKind: 'SINGLE_ALTERNATIVES', continueFrom: 'yoked-1', visible: ['CASE', 'PRIOR_SELF'] },
      { id: 'yoked-3', actor: 'SINGLE', promptKind: 'SINGLE_CHALLENGE', continueFrom: 'yoked-2', visible: ['CASE', 'PRIOR_SELF'] },
      { id: 'yoked-4', actor: 'SINGLE', promptKind: 'SINGLE_EVIDENCE_AUDIT', continueFrom: 'yoked-3', visible: ['CASE', 'PRIOR_SELF'] },
      { id: 'yoked-5', actor: 'SINGLE', promptKind: 'SINGLE_RESOLVE', continueFrom: 'yoked-4', visible: ['CASE', 'PRIOR_SELF'] },
      { id: 'yoked-6', actor: 'SINGLE', promptKind: 'SINGLE_FINAL', continueFrom: 'yoked-5', visible: ['CASE', 'PRIOR_SELF'] }
    ],
    2,
    ['yoked-6']
  ),
  CONTROL_CASE_ONLY_B1: plan(
    'CONTROL_CASE_ONLY_B1',
    ['H1b'],
    'One fresh case-only answer with no sealed initial artifact or controlled signal.',
    [{ id: 'response', actor: 'SINGLE', promptKind: 'POSITION', visible: ['CASE'] }],
    0,
    ['response'],
    'B1'
  ),
  CONTROL_NO_FEEDBACK_B1: controlled('CONTROL_NO_FEEDBACK_B1', 'H1'),
  CONTROL_VALID_CRITIQUE_B1: controlled('CONTROL_VALID_CRITIQUE_B1', 'H1'),
  CONTROL_EVIDENCE_B1: controlled('CONTROL_EVIDENCE_B1', 'H1'),
  CONTROL_INVALID_CRITIQUE_B1: controlled('CONTROL_INVALID_CRITIQUE_B1', 'H1'),
  CONTROL_CONFIDENT_WRONG_B1: controlled('CONTROL_CONFIDENT_WRONG_B1', 'H1'),
  CONTROL_CORRECT_MINORITY_B1: controlled('CONTROL_CORRECT_MINORITY_B1', 'H1')
};

const NON_EXECUTABLE_CONDITIONS: Record<
  LabNonExecutableConditionId,
  LabConditionDeclaration
> = {
  ABC_STOP_CHARGED_PREFIX_B6: {
    conditionId: 'ABC_STOP_CHARGED_PREFIX_B6',
    preregisteredLabel: 'ABC_STOP_CHARGED_PREFIX@B6',
    executionStatus: 'REQUIRES_FROZEN_PREFIX_REPLAY',
    hypothesisIds: ['H4'],
    budgetTier: 'B6',
    prefixSourceConditionId: 'ABC_B5',
    chargedUpstreamCallIds: ['A', 'B', 'C', 'A_RESPONSE', 'B_RESPONSE'],
    reason:
      'The no-audit H4 comparator must reuse and charge a byte-identical realized ABC prefix. The full-live runner cannot yet replay frozen public artifacts, so independently rerunning ABC would not estimate the preregistered contrast.'
  },
  BEST_H4_AUDIT_STOP_B6: {
    conditionId: 'BEST_H4_AUDIT_STOP_B6',
    preregisteredLabel: 'BEST_H4_AUDIT_STOP@B6',
    executionStatus: 'DEFERRED_PREREG_ONLY',
    hypothesisIds: ['H6'],
    budgetTier: 'B6',
    reason: 'H6 cannot name its stop comparator until H4 selects a valid audit arm.'
  },
  AUDIT_TARGETED_RERESPONSE_FINAL_SCOPED_AUDIT_B8: {
    conditionId: 'AUDIT_TARGETED_RERESPONSE_FINAL_SCOPED_AUDIT_B8',
    preregisteredLabel: 'AUDIT_TARGETED_RERESPONSE_FINAL_SCOPED_AUDIT@B8',
    executionStatus: 'DEFERRED_PREREG_ONLY',
    hypothesisIds: ['H6'],
    budgetTier: 'B8',
    reason:
      'The additional-cycle graph, eligibility predicate, and no-new-evidence stop remain preregistered hypotheses and are not implemented.'
  },
  STRONG_SINGLE_B8: {
    conditionId: 'STRONG_SINGLE_B8',
    preregisteredLabel: 'SINGLE_WORKBENCH@B8',
    executionStatus: 'DEFERRED_PREREG_ONLY',
    hypothesisIds: ['H6'],
    budgetTier: 'B8',
    reason: 'The B8 matched single workbench remains gated with H6 and is not implemented.'
  },
  YOKED_SINGLE_B8: {
    conditionId: 'YOKED_SINGLE_B8',
    preregisteredLabel: 'YOKED_SINGLE_IDENTITY@B8',
    executionStatus: 'DEFERRED_PREREG_ONLY',
    hypothesisIds: ['H6'],
    budgetTier: 'B8',
    reason: 'The H6 B8 schedule cannot be yoked until the additional-cycle graph is fixed.'
  }
};

function abcAuditCalls(
  continueFrom?: string,
  auditActor: LabProtocolCall['actor'] = 'C'
): Omit<LabProtocolCall, 'maxOutputTokens'>[] {
  return [
    { id: 'A', actor: 'A', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] },
    { id: 'B', actor: 'B', promptKind: 'POSITION', blindGroup: 'blind-positions', visible: ['CASE'] },
    { id: 'C', actor: 'C', promptKind: 'MAP', visible: ['CASE', 'A', 'B'] },
    { id: 'A_RESPONSE', actor: 'A', promptKind: 'ISSUE_RESPONSE', blindGroup: 'author-responses', continueFrom: 'A', visible: ['CASE', 'A', 'C'] },
    { id: 'B_RESPONSE', actor: 'B', promptKind: 'ISSUE_RESPONSE', blindGroup: 'author-responses', continueFrom: 'B', visible: ['CASE', 'B', 'C'] },
    { id: 'audit', actor: auditActor, promptKind: 'AUDIT', ...(continueFrom ? { continueFrom } : {}), visible: ['CASE', 'A', 'B', 'C', 'A_RESPONSE', 'B_RESPONSE'] }
  ];
}

function singleWorkbench(
  conditionId: 'STRONG_SINGLE_B3' | 'STRONG_SINGLE_B5' | 'STRONG_SINGLE_B6',
  callCount: 3 | 5 | 6,
  hypothesisIds: readonly string[]
): LabProtocolPlan {
  const kinds: LabPromptKind[] = callCount === 3
    ? ['POSITION', 'SINGLE_CHALLENGE', 'SINGLE_FINAL']
    : callCount === 5
      ? [
          'POSITION',
          'SINGLE_CHALLENGE',
          'SINGLE_EVIDENCE_AUDIT',
          'SINGLE_RESOLVE',
          'SINGLE_FINAL'
        ]
      : [
          'POSITION',
          'SINGLE_CHALLENGE',
          'SINGLE_EVIDENCE_AUDIT',
          'SINGLE_ALTERNATIVES',
          'SINGLE_RESOLVE',
          'SINGLE_FINAL'
        ];
  const calls = kinds.map((promptKind, index) => ({
    id: `single-${index + 1}`,
    actor: 'SINGLE' as const,
    promptKind,
    ...(index > 0 ? { continueFrom: `single-${index}` } : {}),
    visible: index === 0 ? ['CASE' as const] : ['CASE' as const, 'PRIOR_SELF' as const]
  }));
  return plan(
    conditionId,
    hypothesisIds,
    `One stable non-social worker receives the full B${callCount} ceiling and may challenge, test, revise, or stop.`,
    calls,
    1,
    [`single-${callCount}`]
  );
}

function controlled(conditionId: LabConditionId, hypothesisId: string): LabProtocolPlan {
  return plan(
    conditionId,
    [hypothesisId],
    'One fresh response to a sealed baseline artifact and a controlled text-only intervention.',
    [{ id: 'response', actor: 'A', promptKind: 'CONTROLLED_RESPONSE', visible: ['CASE', 'INTERVENTION'] }],
    0,
    ['response']
  );
}

export function listLabProtocolPlans(): LabProtocolPlan[] {
  return Object.values(PLANS).map(clonePlan);
}

export function listLabConditionDeclarations(): LabConditionDeclaration[] {
  const executable: LabConditionDeclaration[] = Object.values(PLANS).map((value) => ({
    conditionId: value.conditionId,
    preregisteredLabel: value.conditionId,
    executionStatus: 'EXECUTABLE_FULL_LIVE',
    hypothesisIds: [...value.hypothesisIds],
    budgetTier: value.comparableBudgetTier,
    reason: 'A finite full-live call plan is implemented and validated.'
  }));
  return [...executable, ...Object.values(NON_EXECUTABLE_CONDITIONS)].map((value) =>
    structuredClone(value)
  );
}

export function getLabProtocolPlan(conditionId: LabDeclaredConditionId): LabProtocolPlan {
  const executable = Object.hasOwn(PLANS, conditionId)
    ? PLANS[conditionId as LabConditionId]
    : undefined;
  if (executable) return clonePlan(executable);
  const declaration = NON_EXECUTABLE_CONDITIONS[conditionId as LabNonExecutableConditionId];
  if (declaration) {
    throw new Error(
      `Discourse Lab condition ${conditionId} is not executable: ${declaration.executionStatus}. ${declaration.reason}`
    );
  }
  throw new Error(`Unknown Discourse Lab condition: ${conditionId}`);
}

function clonePlan(value: LabProtocolPlan): LabProtocolPlan {
  return structuredClone(value);
}

export function assertFiniteProtocolPlan(value: LabProtocolPlan): void {
  if (
    Object.hasOwn(NON_EXECUTABLE_CONDITIONS, value.conditionId as LabDeclaredConditionId)
  ) {
    throw new Error(`${value.conditionId} is declared but not executable.`);
  }
  if (value.version !== LAB_PROTOCOL_VERSION) {
    throw new Error(`${value.conditionId} uses an unsupported protocol version.`);
  }
  if (value.calls.length !== value.maximumCalls || value.maximumCalls < 1) {
    throw new Error(`${value.conditionId} has an invalid finite call ceiling.`);
  }
  if (value.maximumRounds < 0 || value.maximumRounds > 2) {
    throw new Error(`${value.conditionId} exceeds the two-round lab ceiling.`);
  }
  if (
    value.calls.reduce((sum, call) => sum + call.maxOutputTokens, 0) !==
    value.maximumOutputTokens
  ) {
    throw new Error(`${value.conditionId} output ceilings do not add up.`);
  }
  const seen = new Set<string>();
  for (const call of value.calls) {
    if (seen.has(call.id)) throw new Error(`${value.conditionId} repeats call id ${call.id}.`);
    if (call.continueFrom && !seen.has(call.continueFrom)) {
      throw new Error(`${value.conditionId} continues from an unavailable call ${call.continueFrom}.`);
    }
    seen.add(call.id);
  }
  for (const terminal of value.terminalArtifacts) {
    if (!seen.has(terminal)) {
      throw new Error(`${value.conditionId} names unavailable terminal artifact ${terminal}.`);
    }
  }
}
