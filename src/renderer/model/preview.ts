import type {
  PreviewApprovalRecord,
  PreviewGenerationRecord,
  PreviewNodeAttemptRecord,
  PreviewPlanRecord,
  PreviewResourceRecord,
  Task,
  WorktreeRecord
} from '../../shared/contracts';
import { PREVIEW_POSIX_INHERITED_ENV_KEYS } from '../../shared/preview';

export type PreviewActionId = 'RESOLVE' | 'APPROVE' | 'START' | 'OPEN' | 'STOP';

export interface PreviewActionModel {
  id: PreviewActionId;
  label: string;
  kind: 'primary' | 'secondary';
}

export interface PreviewViewModel {
  status: string;
  tone: 'neutral' | 'action' | 'success' | 'warning' | 'error';
  summary: string;
  plan?: PreviewPlanRecord;
  approval?: PreviewApprovalRecord;
  generation?: PreviewGenerationRecord;
  latestAttempt?: PreviewNodeAttemptRecord;
  actions: PreviewActionModel[];
}

export interface PreviewPlanLine {
  label: string;
  value: string;
}

export function buildPreviewPlanSummary(plan: PreviewPlanRecord): PreviewPlanLine[] {
  const lines: PreviewPlanLine[] = [
    {
      label: 'Built-in environment',
      value: `${PREVIEW_POSIX_INHERITED_ENV_KEYS.join(', ')} when present; TASK_MONKI_PREVIEW="1"`
    }
  ];
  for (const job of plan.executionPlan.jobs) {
    lines.push({
      label: `Job · ${job.id}`,
      value: `${formatArgv(job.command)} · cwd=${JSON.stringify(job.cwd)}`
    });
  }
  for (const service of plan.executionPlan.services) {
    lines.push({
      label: `Service · ${service.id}`,
      value: `${formatArgv(service.command)} · cwd=${JSON.stringify(service.cwd)}`
    });
    for (const [key, value] of Object.entries(service.env)) {
      lines.push({ label: `Literal env · ${service.id}`, value: `${key}=${JSON.stringify(value)}` });
    }
    for (const [portId, port] of Object.entries(service.ports)) {
      lines.push({
        label: `Generated port · ${service.id}.${portId}`,
        value: `${port.env}=<allocated high TCP port>; listener must be owned by the service group on 127.0.0.1`
      });
    }
    const readinessEnv = service.ports[service.ready.port].env;
    lines.push({
      label: `Readiness · ${service.id}`,
      value: `HTTP 127.0.0.1:<${service.id}.${service.ready.port} via ${readinessEnv}>${service.ready.path} · absolute deadline ${service.ready.timeoutSeconds}s`
    });
  }
  for (const route of plan.executionPlan.routes) {
    lines.push({
      label: `Route · ${route.id}`,
      value: `${route.id} → ${route.service}.${route.port}${route.primary ? ' · primary' : ''}`
    });
  }
  lines.push({
    label: 'Cleanup',
    value: 'Signal only the verified native process group; remove only the marker-owned generation workspace'
  });
  return lines;
}

export function buildPreviewViewModel(input: {
  task: Task;
  worktree?: WorktreeRecord;
  plans: PreviewPlanRecord[];
  approvals: PreviewApprovalRecord[];
  generations: PreviewGenerationRecord[];
  attempts: PreviewNodeAttemptRecord[];
  resources: PreviewResourceRecord[];
}): PreviewViewModel {
  if (!input.worktree || input.worktree.status !== 'PRESENT') {
    return {
      status: 'Unavailable',
      tone: 'neutral',
      summary: 'Prepare the task worktree before checking preview configuration.',
      actions: []
    };
  }
  const plans = input.plans
    .filter((plan) => plan.iterationId === input.task.currentIterationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const plan = plans[0];
  if (!plan) {
    return {
      status: 'Not checked',
      tone: 'neutral',
      summary: 'Check the explicit repository preview recipe. Task Monki will not guess commands.',
      actions: [{ id: 'RESOLVE', label: 'Check preview', kind: 'secondary' }]
    };
  }
  const approval = input.approvals
    .filter(
      (candidate) =>
        candidate.executionDigest === plan.executionDigest && !candidate.invalidatedAt
    )
    .sort((a, b) => b.approvedAt.localeCompare(a.approvedAt))[0];
  const generation = input.generations
    .filter((candidate) => candidate.iterationId === input.task.currentIterationId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const latestAttempt = input.attempts
    .filter((attempt) => attempt.generationId === generation?.id)
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? '').localeCompare(a.endedAt ?? a.startedAt ?? ''))[0];

  if (!approval) {
    return {
      status: 'Approval required',
      tone: 'action',
      summary: 'Review the exact native commands, environment, readiness check, route, and cleanup before running.',
      plan,
      generation,
      latestAttempt,
      actions: [{ id: 'APPROVE', label: 'Approve plan', kind: 'primary' }]
    };
  }
  if (!generation || generation.executionDigest !== plan.executionDigest) {
    return {
      status: 'Ready to start',
      tone: 'action',
      summary: 'The current execution plan is approved. Source will be captured outside the task worktree.',
      plan,
      approval,
      generation,
      latestAttempt,
      actions: [{ id: 'START', label: 'Start preview', kind: 'primary' }]
    };
  }
  if (generation.state === 'READY') {
    return {
      status: generation.freshness === 'STALE' ? 'Running · stale' : 'Running',
      tone: generation.freshness === 'STALE' ? 'warning' : 'success',
      summary:
        generation.freshness === 'STALE'
          ? 'This preview still serves its captured source. The task changed after capture.'
          : 'HTTP readiness passed and the stable Task Monki route is attached.',
      plan,
      approval,
      generation,
      latestAttempt,
      actions: [
        { id: 'OPEN', label: 'Open preview', kind: 'primary' },
        { id: 'STOP', label: 'Stop', kind: 'secondary' }
      ]
    };
  }
  if (generation.state === 'FAILED') {
    return {
      status: 'Failed',
      tone: 'error',
      summary: generation.failureReason ?? 'Preview startup failed. Inspect the recorded node logs.',
      plan,
      approval,
      generation,
      latestAttempt,
      actions: [{ id: 'START', label: 'Try again', kind: 'secondary' }]
    };
  }
  if (generation.state === 'RECOVERY_REQUIRED') {
    return {
      status: 'Recovery required',
      tone: 'error',
      summary: 'Task Monki needs to reconcile the recorded runtime before cleanup can be attempted safely.',
      plan,
      approval,
      generation,
      latestAttempt,
      actions: [{ id: 'STOP', label: 'Retry cleanup', kind: 'secondary' }]
    };
  }
  if (generation.state === 'CLEANUP_INCOMPLETE') {
    return {
      status: 'Cleanup incomplete',
      tone: 'error',
      summary:
        generation.cleanupReason ??
        'Task Monki refused to modify a process or workspace whose ownership could not be verified.',
      plan,
      approval,
      generation,
      latestAttempt,
      actions: [{ id: 'STOP', label: 'Retry cleanup', kind: 'secondary' }]
    };
  }
  if (generation.state === 'STOPPED') {
    return {
      status: 'Stopped',
      tone: 'neutral',
      summary: 'Runtime files are removed; compact manifest and log evidence is retained.',
      plan,
      approval,
      generation,
      latestAttempt,
      actions: [{ id: 'START', label: 'Start preview', kind: 'primary' }]
    };
  }
  return {
    status: humanize(generation.state),
    tone: 'action',
    summary: 'Task Monki is preparing captured source and verifying the declared service readiness.',
    plan,
    approval,
    generation,
    latestAttempt,
    actions: [{ id: 'STOP', label: 'Cancel and clean up', kind: 'secondary' }]
  };
}

function formatArgv(argv: string[]): string {
  return argv.map((argument) => JSON.stringify(argument)).join(' ');
}

function humanize(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}
