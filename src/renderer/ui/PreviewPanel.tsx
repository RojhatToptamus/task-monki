import { useState } from 'react';
import type {
  PreviewApprovalRecord,
  PreviewGenerationRecord,
  PreviewNodeAttemptRecord,
  PreviewPlanRecord,
  PreviewResourceRecord,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
import { buildPreviewViewModel, type PreviewActionId } from '../model/preview';
import { StatusChip } from './StatusBadge';

export function PreviewPanel(props: {
  task: Task;
  worktree?: WorktreeRecord;
  plans: PreviewPlanRecord[];
  approvals: PreviewApprovalRecord[];
  generations: PreviewGenerationRecord[];
  attempts: PreviewNodeAttemptRecord[];
  resources: PreviewResourceRecord[];
  onResolve(taskId: string): Promise<void>;
  onApprove(taskId: string, planId: string, executionDigest: string): Promise<void>;
  onStart(taskId: string): Promise<void>;
  onOpen(taskId: string, generationId: string, routeId: string): Promise<void>;
  onStop(taskId: string, generationId: string): Promise<void>;
  onReadLog(taskId: string, artifactId: string): Promise<string>;
}) {
  const [busy, setBusy] = useState<PreviewActionId>();
  const [logs, setLogs] = useState<string>();
  const [loadingLogs, setLoadingLogs] = useState(false);
  const view = buildPreviewViewModel(props);
  const tone = view.tone === 'warning' ? 'warning' : view.tone === 'neutral' ? 'neutral' : view.tone;

  const act = async (action: PreviewActionId) => {
    if (busy) return;
    setBusy(action);
    try {
      if (action === 'RESOLVE') await props.onResolve(props.task.id);
      if (action === 'APPROVE' && view.plan) {
        await props.onApprove(props.task.id, view.plan.id, view.plan.executionDigest);
      }
      if (action === 'START') await props.onStart(props.task.id);
      if (action === 'OPEN' && view.generation) {
        const route = view.generation.routes.find((candidate) => candidate.state === 'ATTACHED');
        if (route) await props.onOpen(props.task.id, view.generation.id, route.id);
      }
      if (action === 'STOP' && view.generation) {
        await props.onStop(props.task.id, view.generation.id);
      }
    } finally {
      setBusy(undefined);
    }
  };

  const readLogs = async () => {
    if (!view.latestAttempt || loadingLogs) return;
    setLoadingLogs(true);
    try {
      const [stdout, stderr] = await Promise.all([
        props.onReadLog(props.task.id, view.latestAttempt.stdoutArtifactId),
        props.onReadLog(props.task.id, view.latestAttempt.stderrArtifactId)
      ]);
      setLogs([
        stdout ? `stdout\n${stdout}` : '',
        stderr ? `stderr\n${stderr}` : ''
      ].filter(Boolean).join('\n\n') || 'No output was recorded for this node.');
    } finally {
      setLoadingLogs(false);
    }
  };

  return (
    <section className="tm-panel tm-preview" aria-label="Preview">
      <div className="tm-preview__head">
        <h3 className="tm-panel__title">Preview</h3>
        <StatusChip label="Status" value={view.status} tone={tone} />
      </div>
      <p className="tm-panel__lead">{view.summary}</p>

      {view.plan ? <PreviewPlanSummary plan={view.plan} expanded={!view.approval} /> : null}

      <div className="tm-preview__actions">
        {view.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={action.kind === 'primary' ? 'primary-button' : 'outline-button'}
            disabled={Boolean(busy)}
            onClick={() => void act(action.id)}
          >
            {busy === action.id ? 'Working…' : action.label}
          </button>
        ))}
        {view.latestAttempt ? (
          <button
            type="button"
            className="tm-preview__logs-button"
            disabled={loadingLogs}
            onClick={() => void readLogs()}
          >
            {loadingLogs ? 'Loading logs…' : 'View logs'}
          </button>
        ) : null}
      </div>

      {logs !== undefined ? (
        <pre className="tm-preview__logs" aria-label="Preview logs">{logs}</pre>
      ) : null}
    </section>
  );
}

function PreviewPlanSummary({ plan, expanded }: { plan: PreviewPlanRecord; expanded: boolean }) {
  const service = plan.executionPlan.services[0];
  return (
    <details className="tm-preview__plan" open={expanded}>
      <summary>Execution plan</summary>
      <div className="tm-preview__planbody">
        {plan.executionPlan.jobs.map((job) => (
          <PlanLine key={job.id} label="Run once" value={`${job.command.join(' ')} · ${job.cwd}`} />
        ))}
        {service ? (
          <>
            <PlanLine label="Start" value={`${service.command.join(' ')} · ${service.cwd}`} />
            <PlanLine
              label="Environment"
              value={[
                ...Object.keys(service.env),
                ...Object.values(service.ports).map((port) => `${port.env}=<dynamic loopback port>`)
              ].join(', ') || 'Allowlisted base environment only'}
            />
            <PlanLine
              label="Ready"
              value={`HTTP ${service.ready.path} · ${service.ready.timeoutSeconds}s`}
            />
          </>
        ) : null}
        <PlanLine label="Route" value="Stable .preview.localhost URL after readiness" />
        <PlanLine label="Cleanup" value="Verified process group and marker-owned workspace only" />
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
