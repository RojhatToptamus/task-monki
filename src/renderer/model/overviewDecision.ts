import type { WorkflowPhase } from '../../shared/contracts';
import type { PrStatusKind } from './prStatus';

/**
 * Which surface owns the task Overview's Now panel — the one raised
 * element that says what the task needs now. Owners follow PRODUCT_WORKFLOW's
 * UI priority: a decision the user owes the agent, then the checkout the work
 * lives in (Retry and Continue cannot run without it), then recovery, then work
 * in flight, then delivery while a pull request is unmerged, then finishing,
 * then setup. A closed task shows how it ended.
 *
 * The panel never invents an action. Each owner brings the controls it already
 * has elsewhere (the interaction's decisions, the composer's recovery
 * actions, PR Status, the next-action model, worktree setup); the panel only
 * decides which one leads, so a task never shows two competing "next" steps.
 */
export type OverviewDecisionOwner =
  | 'closed'
  | 'interaction'
  | 'checkout'
  | 'recovery'
  | 'running'
  | 'delivery'
  | 'finish'
  | 'setup';

export interface OverviewDecisionInput {
  workflowPhase: WorkflowPhase;
  /** A provider request is pending, or its answer awaits delivery confirmation. */
  interactionPending: boolean;
  /** The current implementation-side run ended unsuccessfully or needs another pass. */
  recoveryRequired: boolean;
  /** An implementation-side run or the agent review is in flight. */
  runInFlight: boolean;
  /** The task's worktree or imported checkout is missing or failed to prepare. */
  checkoutUnavailable: boolean;
  /**
   * A linked pull request is still delivering and is what the task's status
   * word is about. Once merged — or while the agent review asks for action the
   * board card leads with — finishing takes over.
   */
  deliveryOpen: boolean;
  /** The next-action model has something to say: review, findings, finishing, moving to review. */
  finishRelevant: boolean;
  /** A setup step is available: prepare the worktree or start the first run. */
  setupAvailable: boolean;
}

const CLOSED_PHASES = new Set<WorkflowPhase>(['DONE', 'CANCELED', 'ARCHIVED']);

export function selectOverviewDecisionOwner(
  input: OverviewDecisionInput
): OverviewDecisionOwner | undefined {
  if (CLOSED_PHASES.has(input.workflowPhase)) return 'closed';
  if (input.interactionPending) return 'interaction';
  if (input.checkoutUnavailable) return 'checkout';
  if (input.recoveryRequired) return 'recovery';
  if (input.runInFlight) return 'running';
  if (input.deliveryOpen) return 'delivery';
  if (input.finishRelevant) return 'finish';
  if (input.setupAvailable) return 'setup';
  return undefined;
}

export interface PullRequestPlacementInput {
  owner: OverviewDecisionOwner | undefined;
  prKind: PrStatusKind;
  /** PR Status has something the Overview should show. */
  overviewRelevant: boolean;
  canCreateDraftPr: boolean;
  workflowPhase: WorkflowPhase;
}

export interface PullRequestPlacement {
  /** PR Status renders as a flat section of the work column. */
  section: boolean;
  /** Create draft PR joins the finishing actions in the Now panel. */
  createInNowPanel: boolean;
}

/** Owners whose step comes before shipping anything: an unpublished PR would only wait. */
const OWNERS_BEFORE_SHIPPING = new Set<OverviewDecisionOwner>(['interaction', 'checkout', 'recovery', 'running', 'closed']);

/**
 * Where the pull request appears on the Overview, so Create draft PR is
 * offered exactly once. An open PR holds the Now panel. Before any PR exists,
 * creating one is a finishing action while finishing holds the panel, and a
 * PR Status section while setup does; while a request, the checkout, recovery
 * or running work holds the panel, an unpublished PR has nothing to offer yet.
 */
export function selectPullRequestPlacement(input: PullRequestPlacementInput): PullRequestPlacement {
  const none = { section: false, createInNowPanel: false };
  if (input.owner === 'delivery' || !input.overviewRelevant) return none;
  if (input.prKind !== 'NO_PR') return { section: true, createInNowPanel: false };
  if (!input.owner || OWNERS_BEFORE_SHIPPING.has(input.owner) || CLOSED_PHASES.has(input.workflowPhase)) return none;
  if (input.owner === 'finish') return { section: false, createInNowPanel: input.canCreateDraftPr };
  return { section: true, createInNowPanel: false };
}
