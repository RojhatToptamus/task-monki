import type { PreviewApprovalRecord, PreviewPlanRecord } from '../../../shared/contracts';
import { buildPreviewPlanGroups } from '../../model/preview';
import { humanizeEnum } from '../../model/formatting';
import { formatPreviewAttachmentTarget } from '../../model/previewPresentation';

export function PreviewPlanAuthority({
  plan,
  approval
}: {
  plan: PreviewPlanRecord;
  approval?: PreviewApprovalRecord;
}) {
  const groups = buildPreviewPlanGroups(plan);
  const topology = buildPlanTopology(plan);
  const warnings = plan.executionPlan.adapter === 'COMPOSE'
    ? plan.warnings.filter((warning) => !warning.startsWith('Native preview commands run'))
    : plan.warnings;
  const exactDetails = (
    <div className="tm-preview-authority__groups">
      {groups.map((group) => (
        <section key={group.id} className="tm-preview-authority__group">
          <h4>{group.label}</h4>
          <div className="tm-preview-authority__rows">
            {group.lines.map((line, index) => (
              <PlanLine key={`${line.label}-${index}`} label={line.label} value={line.value} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );

  if (approval) {
    return (
      <section className="tm-preview-approved-plan" aria-label="Approved plan">
        <details className="tm-preview-disclosure">
          <summary>Approved plan details</summary>
          {exactDetails}
          <PlanWarnings warnings={warnings} />
        </details>
      </section>
    );
  }

  return (
    <div className="tm-preview-approval" aria-labelledby="preview-plan-authority">
      <section className="tm-preview-surface tm-preview-plan-topology">
        <h3 id="preview-plan-authority" className="tm-preview-surface__title">Execution plan</h3>
        {topology.map((group) => (
          <div key={group.id} className="tm-preview-topology-group">
            <div className="tm-preview-topology-group__head">
              <span>{group.label}</span>
              {group.summary ? <small>{group.summary}</small> : null}
            </div>
            <div className="tm-preview-topology-group__rows">
              {group.rows.map((row) => <PlanTopologyRow key={`${group.id}-${row.id}`} {...row} />)}
            </div>
          </div>
        ))}
        <details className="tm-preview-disclosure tm-preview-plan-topology__exact">
          <summary>Exact commands, recipients, readiness, and cleanup</summary>
          {exactDetails}
        </details>
      </section>
      <aside className="tm-preview-approval__side" aria-label="Plan authority and advisories">
        <PlanAuthorityCard plan={plan} />
        {warnings.length > 0 ? <PlanAdvisories warnings={warnings} /> : null}
        <PlanCleanupCard plan={plan} />
      </aside>
    </div>
  );
}

interface PlanTopologyRowModel {
  id: string;
  title: string;
  value: string;
  meta?: string;
}

interface PlanTopologyGroupModel {
  id: string;
  label: string;
  summary?: string;
  rows: PlanTopologyRowModel[];
}

function buildPlanTopology(plan: PreviewPlanRecord): PlanTopologyGroupModel[] {
  const execution = plan.executionPlan;
  const result: PlanTopologyGroupModel[] = [];
  if (execution.adapter === 'COMPOSE') {
    const services = execution.compose?.inspection?.services ?? [];
    if (services.length > 0) {
      result.push({
        id: 'application',
        label: 'Compose services',
        summary: `${services.length} ${services.length === 1 ? 'service' : 'services'}`,
        rows: services.map((service) => ({
          id: service.id,
          title: service.id,
          value: service.image ?? 'Local build',
          meta: service.dependsOn.length > 0 ? `${service.dependsOn.length} dependencies` : 'root service'
        }))
      });
    }
  } else {
    const application = [
      ...execution.services.map((node) => ({
        id: `service-${node.id}`,
        title: node.label ?? node.id,
        value: formatPlanCommand(node.command),
        meta: execution.routes.some((route) => route.service === node.id) ? 'service · routed' : 'service'
      })),
      ...execution.workers.map((node) => ({
        id: `worker-${node.id}`,
        title: node.label ?? node.id,
        value: formatPlanCommand(node.command),
        meta: node.overlap === 'exclusive' ? 'worker · exclusive' : 'worker · overlap safe'
      }))
    ];
    if (application.length > 0) {
      result.push({
        id: 'application',
        label: 'Application',
        summary: [
          execution.services.length > 0 ? `${execution.services.length} ${execution.services.length === 1 ? 'service' : 'services'}` : undefined,
          execution.workers.length > 0 ? `${execution.workers.length} ${execution.workers.length === 1 ? 'worker' : 'workers'}` : undefined
        ].filter(Boolean).join(' · '),
        rows: application
      });
    }
    const scenario = execution.scenarios.find((candidate) => candidate.id === execution.selectedScenarioId);
    const activeJobs = execution.jobs.filter(
      (job) => job.role === 'generic' || scenario?.jobs.includes(job.id)
    );
    if (activeJobs.length > 0) {
      result.push({
        id: 'setup',
        label: 'Setup jobs',
        summary: 'First start only',
        rows: activeJobs.map((job) => ({
          id: job.id,
          title: job.label ?? job.id,
          value: formatPlanCommand(job.command),
          meta: `${humanizeEnum(job.role)} · ${job.retrySafe ? 'retry-safe' : 'not retry-safe'}`
        }))
      });
    }
  }
  if (execution.routes.length > 0) {
    result.push({
      id: 'routes',
      label: 'Routes',
      summary: 'Stable across replacements',
      rows: execution.routes.map((route) => ({
        id: route.id,
        title: route.id,
        value: `→ ${route.service}.${route.port}`,
        meta: route.primary ? 'primary' : undefined
      }))
    });
  }
  if (execution.adapter === 'COMPOSE') {
    const volumes = execution.compose?.inspection?.volumes.filter((volume) => !volume.external) ?? [];
    if (volumes.length > 0) {
      result.push({
        id: 'data',
        label: 'Managed data',
        summary: 'Project-owned · persistent',
        rows: volumes.map((volume) => ({
          id: volume.name,
          title: volume.name,
          value: 'Compose volume',
          meta: 'owned by this preview'
        }))
      });
    }
  } else {
    const scenario = execution.scenarios.find((candidate) => candidate.id === execution.selectedScenarioId);
    const resources = execution.resources.filter((resource) => scenario?.resources.includes(resource.id));
    if (resources.length > 0) {
      result.push({
        id: 'data',
        label: 'Managed data',
        summary: 'Preview-owned · persistent',
        rows: resources.map((resource) => ({
          id: resource.id,
          title: resource.id,
          value: `${resource.type === 'postgres' ? 'PostgreSQL' : 'Redis'} · ${resource.image}`,
          meta: 'generated credentials'
        }))
      });
    }
  }
  if (execution.inputs?.length) {
    result.push({
      id: 'inputs',
      label: 'Private inputs',
      summary: 'Values excluded from approval',
      rows: execution.inputs.map((input) => ({
        id: input.id,
        title: input.label ?? input.id,
        value: input.id,
        meta: 'encrypted · recipient-scoped'
      }))
    });
  }
  if (execution.attachments?.length) {
    result.push({
      id: 'attachments',
      label: 'Attached dependencies',
      summary: 'External · never managed',
      rows: execution.attachments.map((attachment) => ({
        id: attachment.id,
        title: attachment.label ?? attachment.id,
        value: formatPreviewAttachmentTarget(attachment),
        meta: `${attachment.type.toUpperCase()} · non-owned`
      }))
    });
  }
  return result;
}

function PlanTopologyRow({ title, value, meta }: PlanTopologyRowModel) {
  return (
    <div className="tm-preview-topology-row">
      <span aria-hidden="true">›</span>
      <code>{title}</code>
      <code>{value}</code>
      {meta ? <small>{meta}</small> : <span />}
    </div>
  );
}

function PlanAuthorityCard({ plan }: { plan: PreviewPlanRecord }) {
  const identity = plan.ociCapability?.identity;
  const rows = plan.executionPlan.adapter === 'COMPOSE'
    ? [
        { label: 'Engine', value: identity ? `${identity.contextName} · ${identity.operatingSystem}/${identity.architecture}` : 'Selected local OCI engine' },
        { label: 'Configuration', value: plan.executionPlan.compose?.files.join(', ') ?? 'compose.yaml' },
        { label: 'Project', value: 'One task-scoped serialized project' },
        { label: 'Environment', value: 'Repository Compose configuration · approved as inspected' }
      ]
    : [
        { label: 'Engine', value: identity ? `${identity.contextName} · ${identity.operatingSystem}/${identity.architecture}` : 'Native host' },
        { label: 'Runs as', value: 'Your local user · not sandboxed' },
        { label: 'Network', value: 'Unrestricted for launched processes' },
        { label: 'Environment', value: 'Repository literals + generated and private bindings' }
      ];
  return (
    <section className="tm-preview-surface tm-preview-authority-card">
      <h3 className="tm-preview-surface__title">Authority</h3>
      <div className="tm-preview-authority-card__rows">
        {rows.map((row) => <AuthorityRow key={row.label} {...row} />)}
      </div>
    </section>
  );
}

function PlanAdvisories({ warnings }: { warnings: string[] }) {
  return (
    <section className="tm-preview-surface tm-preview-advisories">
      <h3 className="tm-preview-surface__title">Advisories</h3>
      <ul className="tm-preview-advisories__list">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </section>
  );
}

function PlanCleanupCard({ plan }: { plan: PreviewPlanRecord }) {
  const managedResourceIds = plan.executionPlan.resources.map((resource) => resource.id);
  const rows = [
    {
      label: 'Stop preview',
      value: plan.executionPlan.adapter === 'COMPOSE'
        ? 'Deletes the exact task-scoped project and its owned volumes'
        : managedResourceIds.length > 0
          ? `Deletes exact preview runtime and managed data for ${managedResourceIds.join(', ')}`
          : 'Deletes exact preview runtime; this plan has no managed data'
    },
    ...(plan.executionPlan.resources.length > 0
      ? [{ label: 'Reset', value: 'Deletes one selected managed resource and preserves the rest' }]
      : []),
    {
      label: 'Replace',
      value: plan.executionPlan.adapter === 'COMPOSE'
        ? 'Serializes project activation after build and inspection'
        : managedResourceIds.length > 0
          ? `Keeps managed data for ${managedResourceIds.join(', ')} and cuts routes over only after readiness`
          : 'Cuts routes over only after readiness; no managed data is involved'
    },
    { label: 'Attached', value: 'Never stopped, reset, deleted, or otherwise managed' }
  ];
  return (
    <section className="tm-preview-surface tm-preview-authority-card">
      <h3 className="tm-preview-surface__title">Cleanup contract</h3>
      <div className="tm-preview-authority-card__rows">
        {rows.map((row) => <AuthorityRow key={row.label} {...row} />)}
      </div>
    </section>
  );
}

export function AuthorityRow({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><p>{value}</p></div>;
}

function formatPlanCommand(argv: string[]): string {
  return argv.map((argument) => JSON.stringify(argument)).join(' ');
}

function PlanWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <details className="tm-preview-disclosure tm-preview-authority__warning-disclosure">
      <summary>Plan warnings · {warnings.length}</summary>
      <div className="tm-preview-authority__warnings">
        {warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </div>
    </details>
  );
}

function PlanLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="tm-preview-planline">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}
