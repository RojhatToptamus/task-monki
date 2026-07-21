import { useState } from 'react';
import {
  buildPreviewViewModel,
  selectPreviewActionGeneration,
  selectPreviewResetResources,
  type PreviewActionId,
  type PreviewActionModel
} from '../../model/preview';
import type {
  PreviewConfirmation,
  PreviewController,
  PreviewPanelProps
} from './types';

export function usePreviewController(
  props: PreviewPanelProps
): PreviewController {
  const [busy, setBusy] = useState<Set<PreviewActionId>>(() => new Set());
  const [resetBusy, setResetBusy] = useState<string>();
  const [confirmation, setConfirmation] = useState<PreviewConfirmation>();
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const view = buildPreviewViewModel(props);
  const resetGeneration =
    view.recoveryGeneration ?? view.activeGeneration ?? view.generation;
  const resettableResources = selectPreviewResetResources(props, view);

  const runAction = async (action: PreviewActionId) => {
    if (
      busy.has(action) ||
      (busy.size > 0 &&
        !(['OPEN', 'STOP'].includes(action) && busy.has('START')))
    ) {
      return;
    }
    setBusy((current) => new Set(current).add(action));
    try {
      if (action === 'RESOLVE') await props.onResolve(props.task.id);
      if (action === 'APPROVE' && view.plan) {
        await props.onApprove(
          props.task.id,
          view.plan.id,
          view.plan.executionDigest
        );
      }
      if (action === 'START') {
        await props.onStart(
          props.task.id,
          view.plan?.executionPlan.selectedScenarioId
        );
      }
      const retryGeneration = view.recoveryGeneration ?? view.generation;
      if (action === 'RETRY_SETUP' && retryGeneration && view.plan) {
        await props.onRetrySetup(
          props.task.id,
          retryGeneration.id,
          view.plan.executionPlan.selectedScenarioId
        );
      }
      const openGeneration = selectPreviewActionGeneration(view, 'OPEN');
      if (action === 'OPEN' && openGeneration) {
        const route = openGeneration.routes.find(
          (candidate) => candidate.state === 'ATTACHED'
        );
        if (route) await props.onOpen(props.task.id, openGeneration.id, route.id);
      }
      const stopGeneration = selectPreviewActionGeneration(view, 'STOP');
      if (action === 'STOP' && stopGeneration) {
        await props.onStop(props.task.id, stopGeneration.id);
      }
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(action);
        return next;
      });
    }
  };

  const runReset = async (resourceId: string) => {
    const generation = resetGeneration;
    const scenarioId = view.plan?.executionPlan.selectedScenarioId;
    if (!generation || !scenarioId || resetBusy) return;
    setResetBusy(resourceId);
    try {
      await props.onResetData(
        props.task.id,
        generation.id,
        resourceId,
        scenarioId
      );
    } finally {
      setResetBusy(undefined);
    }
  };

  const requestAction = (
    action: PreviewActionModel,
    returnFocus?: HTMLElement
  ) => {
    if (action.id !== 'STOP' || action.label === 'Retry cleanup') {
      void runAction(action.id);
      return;
    }
    const destructive = action.label.includes('Delete Data');
    const adapter = view.plan?.executionPlan.adapter;
    const managedResourceIds =
      view.plan?.executionPlan.resources.map((resource) => resource.id) ?? [];
    const hasManagedData = managedResourceIds.length > 0;
    const managedResourceSummary = managedResourceIds.join(', ');
    const body = destructive
      ? adapter === 'COMPOSE'
        ? 'Stops the stable Compose preview and permanently deletes every active or retained Task Monki-owned volume. External resources, images, and build cache are not changed.'
        : hasManagedData
          ? `Stops this preview and permanently deletes Task Monki-managed data for ${managedResourceSummary}. Attached dependencies are never changed.`
          : 'Stops this preview and permanently removes its Task Monki-owned runtime. This plan has no managed database or cache data.'
      : action.label === 'Cancel replacement'
        ? 'Stops and verifies only the candidate generation. The current active preview stays available and its managed data is preserved.'
        : 'Cancels startup and runs the recorded exact cleanup path. Preview-owned runtime and managed data covered by this generation may be deleted.';
    setConfirmation(() => ({
      title: destructive ? 'Stop preview & delete data?' : action.label,
      body,
      confirmLabel: destructive ? 'Stop & delete' : action.label,
      danger: destructive || action.label !== 'Cancel replacement',
      impacts: destructive
        ? [
            {
              tone: 'deleted',
              detail:
                adapter === 'COMPOSE'
                  ? 'Task-scoped project containers, owned networks, owned volumes, and their data'
                  : hasManagedData
                    ? `Preview runtime plus managed data for ${managedResourceSummary}`
                    : 'Preview processes, routes, ports, and captured workspace'
            },
            {
              tone: 'kept',
              detail:
                'Worktree, branch, approved plan, public bindings, and retained evidence'
            },
            {
              tone: 'untouched',
              detail: 'Attached dependencies and resources owned outside this preview'
            }
          ]
        : undefined,
      requireText: destructive ? 'delete' : undefined,
      returnFocus,
      run: () => runAction('STOP')
    }));
  };

  const requestReset = (resourceId: string, returnFocus?: HTMLElement) => {
    setConfirmation(() => ({
      title: `Reset ${resourceId}?`,
      body: `Stops the complete preview, permanently deletes only ${resourceId}'s Task Monki-managed data, and cannot restore it if recreation or setup fails. Attached dependencies are never changed.`,
      confirmLabel: `Reset ${resourceId}`,
      danger: true,
      impacts: [
        { tone: 'deleted', detail: `${resourceId} managed data` },
        {
          tone: 'kept',
          detail:
            'Other managed data, worktree, stable route identities, and approval'
        },
        { tone: 'untouched', detail: 'Attached dependencies' }
      ],
      returnFocus,
      run: () => runReset(resourceId)
    }));
  };

  const closeConfirmation = () => {
    if (!confirmationBusy) setConfirmation(undefined);
  };
  const confirm = async () => {
    if (!confirmation || confirmationBusy) return;
    setConfirmationBusy(true);
    try {
      await confirmation.run();
      setConfirmation(undefined);
    } finally {
      setConfirmationBusy(false);
    }
  };

  return {
    view,
    busy,
    resetBusy,
    resettableResources,
    confirmation,
    confirmationBusy,
    runAction,
    requestAction,
    requestReset,
    closeConfirmation,
    confirm
  };
}
