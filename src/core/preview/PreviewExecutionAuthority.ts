import type {
  PreviewAttachmentPlan,
  PreviewEnvironmentValue,
  PreviewExecutionPlan,
  PreviewJobPlan,
  PreviewLocalAttachmentRequirement,
  PreviewLocalAttachmentUsage,
  PreviewServicePlan,
  PreviewWorkerPlan
} from '../../shared/preview';
import { canonicalJson, sha256 } from './PreviewCanonicalDigest';

function executionAuthority(plan: PreviewExecutionPlan): unknown {
  if (plan.adapter === 'COMPOSE') {
    if (!plan.compose) throw new Error('Compose execution authority is missing its declaration.');
    return {
      version: plan.version,
      adapter: 'COMPOSE',
      compose: plan.compose,
      routes: plan.routes
    };
  }
  const scenario = plan.scenarios.find((candidate) => candidate.id === plan.selectedScenarioId);
  if (!scenario) throw new Error(`Selected preview scenario is missing: ${plan.selectedScenarioId}.`);
  const activeJobs = new Set([
    ...plan.jobs.filter((job) => job.role === 'generic').map((job) => job.id),
    ...scenario.jobs
  ]);
  const activeResources = new Set(scenario.resources);
  const { activeAttachmentIds, checkedAttachmentIds, activeInputIds } =
    collectActiveBindingAuthority(plan, activeJobs);
  const activeAttachments = (plan.attachments ?? []).filter(
    (attachment) => activeAttachmentIds.has(attachment.id)
  );
  for (const attachment of activeAttachments) {
    const passwordInput = attachmentPasswordInput(attachment);
    if (passwordInput) activeInputIds.add(passwordInput);
  }
  return {
    version: plan.version,
    selectedScenarioId: plan.selectedScenarioId,
    inputs: (plan.inputs ?? [])
      .filter((input) => activeInputIds.has(input.id))
      .map(({ label: _label, ...input }) => input),
    attachments: activeAttachments.map(({ label: _label, check, ...attachment }) => ({
      ...attachment,
      check: checkedAttachmentIds.has(attachment.id) ? check : undefined
    })),
    jobs: plan.jobs
      .filter((job) => activeJobs.has(job.id))
      .map(({ label: _label, ...job }) => job),
    resources: plan.resources
      .filter((resource) => activeResources.has(resource.id))
      .map(({ label: _label, ...resource }) => resource),
    services: plan.services.map(({ label: _label, ...service }) => service),
    workers: plan.workers.map(({ label: _label, ...worker }) => worker),
    routes: plan.routes
  };
}

export function previewExecutionDigest(plan: PreviewExecutionPlan): string {
  return sha256(canonicalJson(executionAuthority(plan)));
}

export function activePreviewAttachmentIds(plan: PreviewExecutionPlan): string[] {
  if (plan.adapter === 'COMPOSE') return [];
  const scenario = plan.scenarios.find((candidate) => candidate.id === plan.selectedScenarioId);
  if (!scenario) return [];
  const activeJobs = new Set([
    ...plan.jobs.filter((job) => job.role === 'generic').map((job) => job.id),
    ...scenario.jobs
  ]);
  return [...collectActiveBindingAuthority(plan, activeJobs).activeAttachmentIds].sort();
}

export function activePreviewLocalAttachmentRequirements(
  plan: PreviewExecutionPlan
): PreviewLocalAttachmentRequirement[] {
  if (plan.adapter === 'COMPOSE') return [];
  const scenario = plan.scenarios.find((candidate) => candidate.id === plan.selectedScenarioId);
  if (!scenario) return [];
  const activeJobs = new Set([
    ...plan.jobs.filter((job) => job.role === 'generic').map((job) => job.id),
    ...scenario.jobs
  ]);
  const authority = collectActiveBindingAuthority(plan, activeJobs);
  return (plan.attachments ?? [])
    .filter(
      (attachment) =>
        attachment.target.type === 'local' && authority.activeAttachmentIds.has(attachment.id)
    )
    .map((attachment) => ({
      attachmentId: attachment.id,
      label: attachment.label,
      attachmentType: attachment.type,
      allowedTargetTypes: attachment.type === 'http'
        ? ['endpoint', 'task-preview-route']
        : ['endpoint'],
      usages: authority.attachmentUsages.get(attachment.id) ?? []
    }));
}

export function activePreviewInputIds(plan: PreviewExecutionPlan): string[] {
  if (plan.adapter === 'COMPOSE') return [];
  const scenario = plan.scenarios.find((candidate) => candidate.id === plan.selectedScenarioId);
  if (!scenario) return [];
  const activeJobs = new Set([
    ...plan.jobs.filter((job) => job.role === 'generic').map((job) => job.id),
    ...scenario.jobs
  ]);
  return [...collectActiveBindingAuthority(plan, activeJobs).activeInputIds].sort();
}

function collectActiveBindingAuthority(
  plan: PreviewExecutionPlan,
  activeJobs: ReadonlySet<string>
): {
  activeAttachmentIds: Set<string>;
  checkedAttachmentIds: Set<string>;
  activeInputIds: Set<string>;
  attachmentUsages: Map<string, PreviewLocalAttachmentUsage[]>;
} {
  const activeNodes: Array<{
    kind: 'JOB' | 'SERVICE' | 'WORKER';
    node: PreviewJobPlan | PreviewServicePlan | PreviewWorkerPlan;
  }> = [
    ...plan.jobs.filter((job) => activeJobs.has(job.id)).map((node) => ({ kind: 'JOB' as const, node })),
    ...plan.services.map((node) => ({ kind: 'SERVICE' as const, node })),
    ...plan.workers.map((node) => ({ kind: 'WORKER' as const, node }))
  ];
  const activeAttachmentIds = new Set<string>();
  const checkedAttachmentIds = new Set<string>();
  const activeInputIds = new Set<string>();
  const attachmentUsages = new Map<string, PreviewLocalAttachmentUsage[]>();
  const attachmentIds = new Set((plan.attachments ?? []).map((attachment) => attachment.id));
  const addEnvironmentUsages = (
    nodeKind: 'JOB' | 'SERVICE' | 'WORKER',
    nodeId: string,
    recipient: 'PROCESS' | 'READINESS_PROBE' | 'LIVENESS_PROBE',
    environment: Record<string, PreviewEnvironmentValue>
  ) => {
    const keysByAttachment = new Map<string, string[]>();
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value === 'string') continue;
      if (value.type === 'private-input') {
        activeInputIds.add(value.input);
        continue;
      }
      if (!('attachment' in value)) continue;
      activeAttachmentIds.add(value.attachment);
      const keys = keysByAttachment.get(value.attachment) ?? [];
      keys.push(key);
      keysByAttachment.set(value.attachment, keys);
    }
    for (const [attachmentId, environmentKeys] of keysByAttachment) {
      const usages = attachmentUsages.get(attachmentId) ?? [];
      usages.push({
        kind: 'ENVIRONMENT',
        recipient,
        nodeKind,
        nodeId,
        environmentKeys: environmentKeys.sort()
      });
      attachmentUsages.set(attachmentId, usages);
    }
  };
  for (const { kind, node } of activeNodes) {
    for (const dependencyId of Object.keys(node.needs)) {
      if (attachmentIds.has(dependencyId)) {
        activeAttachmentIds.add(dependencyId);
        checkedAttachmentIds.add(dependencyId);
        const usages = attachmentUsages.get(dependencyId) ?? [];
        usages.push({ kind: 'READINESS_DEPENDENCY', nodeKind: kind, nodeId: node.id });
        attachmentUsages.set(dependencyId, usages);
      }
    }
    addEnvironmentUsages(kind, node.id, 'PROCESS', node.env);
    if ('ready' in node && node.ready.type === 'argv') {
      addEnvironmentUsages(kind, node.id, 'READINESS_PROBE', node.ready.env ?? {});
    }
    if ('liveness' in node && node.liveness?.probe.type === 'argv') {
      addEnvironmentUsages(kind, node.id, 'LIVENESS_PROBE', node.liveness.probe.env ?? {});
    }
  }
  for (const attachment of plan.attachments ?? []) {
    const passwordInput = attachmentPasswordInput(attachment);
    if (activeAttachmentIds.has(attachment.id) && passwordInput) {
      activeInputIds.add(passwordInput);
    }
  }
  return { activeAttachmentIds, checkedAttachmentIds, activeInputIds, attachmentUsages };
}

export function attachmentPasswordInput(
  attachment: PreviewAttachmentPlan
): string | undefined {
  return 'passwordInput' in attachment ? attachment.passwordInput : undefined;
}
