import { describe, expect, it } from 'vitest';
import { selectOverviewDecisionOwner, selectPullRequestPlacement, type OverviewDecisionInput } from './overviewDecision';

function input(overrides: Partial<OverviewDecisionInput> = {}): OverviewDecisionInput {
  return {
    workflowPhase: 'REVIEW',
    interactionPending: false,
    recoveryRequired: false,
    runInFlight: false,
    checkoutUnavailable: false,
    deliveryOpen: false,
    finishRelevant: false,
    setupAvailable: false,
    ...overrides
  };
}

describe('selectOverviewDecisionOwner', () => {
  it('gives the slot to the most urgent owner, in PRODUCT_WORKFLOW priority', () => {
    const everything = {
      interactionPending: true,
      recoveryRequired: true,
      runInFlight: true,
      checkoutUnavailable: true,
      deliveryOpen: true,
      finishRelevant: true,
      setupAvailable: true
    };
    // Remove the winner one at a time: each owner yields only to the one above it.
    const order = [
      'interactionPending',
      'checkoutUnavailable',
      'recoveryRequired',
      'runInFlight',
      'deliveryOpen',
      'finishRelevant',
      'setupAvailable'
    ] as const;
    const owners = order.map((_, index) => selectOverviewDecisionOwner(input({
      ...everything,
      ...Object.fromEntries(order.slice(0, index).map((key) => [key, false]))
    })));

    expect(owners).toEqual([
      'interaction',
      'checkout',
      'recovery',
      'running',
      'delivery',
      'finish',
      'setup'
    ]);
  });

  it('shows how a closed task ended instead of any action', () => {
    for (const workflowPhase of ['DONE', 'CANCELED', 'ARCHIVED'] as const) {
      expect(selectOverviewDecisionOwner(input({
        workflowPhase,
        deliveryOpen: true,
        finishRelevant: true
      }))).toBe('closed');
    }
  });

  it('leaves the slot empty when nothing needs a decision', () => {
    expect(selectOverviewDecisionOwner(input({ workflowPhase: 'BACKLOG' }))).toBeUndefined();
  });

  it('offers Create draft PR exactly once wherever the task stands before a PR exists', () => {
    const place = (owner: Parameters<typeof selectPullRequestPlacement>[0]['owner'], overrides = {}) =>
      selectPullRequestPlacement({
        owner,
        prKind: 'NO_PR',
        overviewRelevant: true,
        canCreateDraftPr: true,
        workflowPhase: 'REVIEW',
        ...overrides
      });

    // Finishing holds the panel: creating a PR is one of its actions, with no section beside it.
    expect(place('finish')).toEqual({ section: false, createInNowPanel: true });
    // Ready work with something to publish keeps PR Status as a section.
    expect(place('setup', { workflowPhase: 'READY' })).toEqual({ section: true, createInNowPanel: false });
    // While running work, a request, recovery or the checkout holds the panel, nothing is ready to ship.
    expect(place('running', { workflowPhase: 'IN_PROGRESS' })).toEqual({ section: false, createInNowPanel: false });
    expect(place('interaction', { workflowPhase: 'IN_PROGRESS' })).toEqual({ section: false, createInNowPanel: false });
    expect(place('checkout')).toEqual({ section: false, createInNowPanel: false });
    expect(place('recovery')).toEqual({ section: false, createInNowPanel: false });
    expect(place('closed', { workflowPhase: 'CANCELED' })).toEqual({ section: false, createInNowPanel: false });
    // Once a PR exists, PR Status owns it: in the panel while open, else a section.
    expect(place('delivery', { prKind: 'OPEN' })).toEqual({ section: false, createInNowPanel: false });
    expect(place('finish', { prKind: 'MERGED' })).toEqual({ section: true, createInNowPanel: false });
  });
});
