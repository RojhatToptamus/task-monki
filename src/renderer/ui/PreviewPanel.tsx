import { useEffect, useRef, useState } from 'react';
import type {
  PreviewApprovalRecord,
  PreviewGenerationAttachmentRecord,
  PreviewGenerationRecord,
  PreviewManagedResourceRecord,
  PreviewNodeAttemptRecord,
  PreviewPlanRecord,
  ReadPreviewLogResult,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
import {
  buildPreviewPlanSummary,
  buildPreviewViewModel,
  selectPreviewActionGeneration,
  selectPreviewDiagnosticAttempts,
  type PreviewActionId
} from '../model/preview';
import { StatusChip } from './StatusBadge';

export function PreviewPanel(props: {
  task: Task;
  worktree?: WorktreeRecord;
  plans: PreviewPlanRecord[];
  approvals: PreviewApprovalRecord[];
  generations: PreviewGenerationRecord[];
  generationAttachments: PreviewGenerationAttachmentRecord[];
  attempts: PreviewNodeAttemptRecord[];
  managedResources: PreviewManagedResourceRecord[];
  onResolve(taskId: string, scenarioId?: string): Promise<void>;
  onApprove(taskId: string, planId: string, executionDigest: string): Promise<void>;
  onStart(taskId: string, scenarioId?: string): Promise<void>;
  onOpen(taskId: string, generationId: string, routeId: string): Promise<void>;
  onStop(taskId: string, generationId: string): Promise<void>;
  onResetData(taskId: string, generationId: string, resourceId: string, scenarioId: string): Promise<void>;
  onRetrySetup(taskId: string, generationId: string, scenarioId: string): Promise<void>;
  onReadLog(taskId: string, artifactId: string, offset: number, maxBytes: number): Promise<ReadPreviewLogResult>;
}) {
  const [busy, setBusy] = useState<Set<PreviewActionId>>(() => new Set());
  const [logs, setLogs] = useState<string>();
  const [selectedAttemptId, setSelectedAttemptId] = useState<string>();
  const [selectedStream, setSelectedStream] = useState<'stdout' | 'stderr'>('stdout');
  const [resetBusy, setResetBusy] = useState<string>();
  const view = buildPreviewViewModel(props);
  const tone = view.tone === 'warning' ? 'warning' : view.tone === 'neutral' ? 'neutral' : view.tone;

  const act = async (action: PreviewActionId) => {
    if (busy.has(action) || (busy.size > 0 && !(action === 'STOP' && busy.has('START')))) return;
    setBusy((current) => new Set(current).add(action));
    try {
      if (action === 'RESOLVE') await props.onResolve(props.task.id);
      if (action === 'APPROVE' && view.plan) {
        await props.onApprove(props.task.id, view.plan.id, view.plan.executionDigest);
      }
      if (action === 'START') {
        await props.onStart(props.task.id, view.plan?.executionPlan.selectedScenarioId);
      }
      if (action === 'RETRY_SETUP' && view.generation && view.plan) {
        await props.onRetrySetup(
          props.task.id,
          view.generation.id,
          view.plan.executionPlan.selectedScenarioId
        );
      }
      const openGeneration = selectPreviewActionGeneration(view, 'OPEN');
      if (action === 'OPEN' && openGeneration) {
        const route = openGeneration.routes.find((candidate) => candidate.state === 'ATTACHED');
        if (route) await props.onOpen(props.task.id, openGeneration.id, route.id);
      }
      const stopGeneration = selectPreviewActionGeneration(view, 'STOP');
      if (action === 'STOP' && stopGeneration) {
        const destructive = view.actions.find((candidate) => candidate.id === 'STOP')?.label.includes('Delete Data');
        if (destructive && !window.confirm('Stop this preview and permanently delete its managed PostgreSQL/Redis data?')) return;
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

  const selectedAttempt = props.attempts.find(
    (attempt) => attempt.id === (selectedAttemptId ?? view.latestAttempt?.id)
  );
  const diagnosticAttempts = selectPreviewDiagnosticAttempts(props.attempts, view);
  const selectedArtifactId = selectedAttempt
    ? selectedStream === 'stdout'
      ? selectedAttempt.stdoutArtifactId
      : selectedAttempt.stderrArtifactId
    : undefined;
  const selectedAttemptTerminal = selectedAttempt
    ? ['SUCCEEDED', 'FAILED', 'STOPPED', 'RECOVERY_REQUIRED'].includes(selectedAttempt.state)
    : true;
  const selectedAttemptTerminalRef = useRef(selectedAttemptTerminal);
  selectedAttemptTerminalRef.current = selectedAttemptTerminal;

  useEffect(() => {
    if (logs === undefined || !selectedArtifactId) return;
    let canceled = false;
    let offset = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLogs('');
    const poll = async () => {
      let continuePolling = true;
      try {
        const result = await props.onReadLog(props.task.id, selectedArtifactId, offset, 64 * 1024);
        if (canceled) return;
        offset = result.nextOffset;
        if (result.chunk) setLogs((current) => `${current ?? ''}${result.chunk}`);
        if (result.endOfFile && selectedAttemptTerminalRef.current) continuePolling = false;
      } catch {
        continuePolling = false;
      } finally {
        if (!canceled && continuePolling) timer = setTimeout(() => void poll(), 750);
      }
    };
    void poll();
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
    // The selected artifact owns this polling lifecycle; callback identity is intentionally irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArtifactId, logs === undefined, props.task.id]);

  const readLogs = () => {
    if (!view.latestAttempt) return;
    setSelectedAttemptId(view.latestAttempt.id);
    setSelectedStream('stdout');
    setLogs('');
  };

  const resetData = async (resourceId: string) => {
    const generation = view.activeGeneration ?? view.generation;
    const scenarioId = view.plan?.executionPlan.selectedScenarioId;
    if (!generation || !scenarioId || resetBusy) return;
    if (!window.confirm(
      `Reset ${resourceId}? This stops the complete preview, permanently deletes this resource's data, and cannot restore it if recreation or setup fails.`
    )) return;
    setResetBusy(resourceId);
    try {
      await props.onResetData(props.task.id, generation.id, resourceId, scenarioId);
    } finally {
      setResetBusy(undefined);
    }
  };

  return (
    <section className="tm-panel tm-preview" aria-label="Preview">
      <div className="tm-preview__head">
        <h3 className="tm-panel__title">Preview</h3>
        <StatusChip label="Status" value={view.status} tone={tone} />
      </div>
      <p className="tm-panel__lead">{view.summary}</p>

      {view.plan && view.plan.executionPlan.scenarios.length > 1 ? (
        <label className="tm-field">
          <span>Data scenario</span>
          <select
            value={view.plan.executionPlan.selectedScenarioId}
            disabled={busy.size > 0 || Boolean(resetBusy)}
            onChange={(event) => void props.onResolve(props.task.id, event.target.value)}
          >
            {view.plan.executionPlan.scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>{scenario.label ?? scenario.id}</option>
            ))}
          </select>
        </label>
      ) : null}

      {view.plan ? <PreviewPlanSummary plan={view.plan} expanded={!view.approval} /> : null}

      <div className="tm-preview__actions">
        {view.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={action.kind === 'primary' ? 'primary-button' : 'outline-button'}
            disabled={busy.has(action.id) || (busy.size > 0 && !(action.id === 'STOP' && busy.has('START')))}
            onClick={() => void act(action.id)}
          >
            {busy.has(action.id) ? 'Working…' : action.label}
          </button>
        ))}
        {view.latestAttempt ? (
          <button
            type="button"
            className="tm-preview__logs-button"
            onClick={readLogs}
          >
            View logs
          </button>
        ) : null}
        {(view.activeGeneration ?? view.generation)?.state === 'READY' && view.plan ? view.plan.executionPlan.resources
          .map((resource) => (
            <button
              key={`reset-${resource.id}`}
              type="button"
              className="outline-button"
              disabled={Boolean(resetBusy) || busy.size > 0}
              onClick={() => void resetData(resource.id)}
            >
              {resetBusy === resource.id ? 'Resetting…' : `Reset ${resource.id} data`}
            </button>
          )) : null}
      </div>

      {logs !== undefined ? (
        <div className="tm-preview__logviewer">
          <div className="tm-preview__logcontrols">
            <select
              aria-label="Preview node attempt"
              value={selectedAttempt?.id ?? ''}
              onChange={(event) => setSelectedAttemptId(event.target.value)}
            >
              {diagnosticAttempts.map((attempt) => (
                  <option key={attempt.id} value={attempt.id}>{attempt.nodeId} · attempt {attempt.attempt} · {attempt.state}</option>
                ))}
            </select>
            <select aria-label="Preview log stream" value={selectedStream} onChange={(event) => setSelectedStream(event.target.value as 'stdout' | 'stderr')}>
              <option value="stdout">stdout</option>
              <option value="stderr">stderr</option>
            </select>
            <button type="button" className="tm-preview__logs-button" onClick={() => setLogs(undefined)}>Close logs</button>
          </div>
          <pre className="tm-preview__logs" aria-label="Preview logs">{logs || 'No output recorded yet.'}</pre>
        </div>
      ) : null}
    </section>
  );
}

function PreviewPlanSummary({ plan, expanded }: { plan: PreviewPlanRecord; expanded: boolean }) {
  const lines = buildPreviewPlanSummary(plan);
  return (
    <details className="tm-preview__plan" open={expanded}>
      <summary>Execution plan</summary>
      <div className="tm-preview__planbody">
        {lines.map((line, index) => (
          <PlanLine key={`${line.label}-${index}`} label={line.label} value={line.value} />
        ))}
        {plan.warnings.map((warning) => (
          <p key={warning} className="tm-preview__warning">{warning}</p>
        ))}
      </div>
    </details>
  );
}

function PlanLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="tm-preview__planline">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}
