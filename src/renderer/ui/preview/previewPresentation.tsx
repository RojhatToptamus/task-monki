import {
  useLayoutEffect,
  useRef,
  type FormEventHandler,
  type ReactNode,
  type RefObject
} from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import type {
  ConfigurationBindingsInspection,
  PreviewStatus,
  ServiceStatus
} from 'previewhost';
import type { OpenTargetRef } from '../../../shared/contracts';
import { serviceOutcome } from '../../model/applicationPreviewRuns';
import { DisclosureChevron } from '../DisclosureChevron';
import { useDialogFocusBoundary } from '../dialogFocus';
import { SourceFolderActions } from './PreviewSourceFolder';

export const message = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
        ''
      )
    : 'The preview request failed.';
export const expected = (status?: PreviewStatus) => ({
  active: status?.active?.id ?? null,
  candidate: status?.candidate?.id ?? null,
  latest: status?.latest?.id ?? null
});
/** Run times use the system clock format without seconds. */
export const clock = (iso: string) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
};
export const label = (state: string) =>
  state.replaceAll('-', ' ').replace(/^./, (value) => value.toUpperCase());

export function serviceTypeLabel(type: string): string {
  if (type === 'command') return 'Server';
  if (type === 'job') return 'Step';
  if (type === 'worker') return 'Worker';
  if (type === 'attach') return 'External HTTP';
  if (type === 'static') return 'Static files';
  if (type === 'postgres' || type === 'external-postgres') return 'PostgreSQL';
  if (type === 'redis' || type === 'external-redis') return 'Redis';
  if (type === 'external-tcp') return 'External TCP';
  if (type === 'compose') return 'Compose service';
  return label(type);
}

/** The last two segments keep a long machine path recognisable; the full path stays in `title`. */
export function shortenPath(directory: string): string {
  const parts = directory.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : directory;
}

/** Where a command runs, named for the person: the task's own worktree or an external folder. */
export function folderName(directory: string, projectDirectory?: string): string {
  if (projectDirectory) {
    if (directory === projectDirectory) return 'worktree';
    if (directory.startsWith(`${projectDirectory}/`))
      return `worktree/${directory.slice(projectDirectory.length + 1)}`;
  }
  return directory.split('/').filter(Boolean).at(-1) ?? directory;
}

export function CopyPath({ path }: { path: string }) {
  return (
    <button
      type="button"
      className="ghost-button"
      onClick={() => void navigator.clipboard.writeText(path)}
    >
      Copy path
    </button>
  );
}

export function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="tm-preview-group">{children}</p>;
}

/** Disclosure summaries share one chevron and type treatment. */
export function DisclosureSummary({ children }: { children: ReactNode }) {
  return (
    <summary>
      <DisclosureChevron />
      {children}
    </summary>
  );
}

/** One state word per service, in a table or at the end of a row; the deciding fact follows it. */
export function StateWord({ service }: { service: Pick<ServiceStatus, 'type' | 'state' | 'waitingFor' | 'error'> }) {
  const outcome = serviceOutcome(service);
  return (
    <span className="tm-application-preview__state" data-state={service.state}>
      {outcome.word}
      {outcome.detail ? <span className="tm-application-preview__state-detail"> · {outcome.detail}</span> : null}
    </span>
  );
}

/** Name, one line of detail, the value or action on the right. The one row shape in Preview. */
export function Row({ name, detail, end, children, title, expansion }: {
  name: ReactNode;
  detail?: ReactNode;
  /** A second, muted line under the detail. */
  children?: ReactNode;
  end?: ReactNode;
  title?: string;
  /** A full-width block under the row, such as the editor for its value. */
  expansion?: ReactNode;
}) {
  return (
    <div className="tm-preview-row">
      <span className="tm-preview-row__name" title={title}>{name}</span>
      <div className="tm-preview-row__detail">
        {detail}
        {children ? <small>{children}</small> : null}
      </div>
      <span className="tm-preview-row__end">{end}</span>
      {expansion ? <div className="tm-preview-row__expansion">{expansion}</div> : null}
    </div>
  );
}

export function PreviewDialog({
  title,
  busy,
  onClose,
  onOpenChange,
  children,
  footer,
  onSubmit,
  size = 'form',
  fallbackReturnFocusRef,
  returnFocus
}: {
  size?: 'compact' | 'form' | 'review';
  returnFocus?: HTMLElement | null;
  fallbackReturnFocusRef?: RefObject<HTMLElement | null>;
  title: string;
  busy: boolean;
  onClose(): void;
  onOpenChange?(open: boolean): void;
  children: ReactNode;
  footer: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    onOpenChange?.(true);
    return () => onOpenChange?.(false);
  }, [onOpenChange]);
  useDialogFocusBoundary({
    dialogRef: ref,
    busy,
    onClose,
    fallbackReturnFocusRef,
    returnFocus
  });
  const contents = (
    <>
      <div className="tm-application-preview__dialog-body">{children}</div>
      <footer className="tm-modal__actions">{footer}</footer>
    </>
  );
  return createPortal(
    <div className="tm-modal">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onClose} />
      <div
        ref={ref}
        className={`tm-modal__panel tm-application-preview__dialog tm-application-preview__dialog--${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="tm-application-preview__dialog-head">
          <h3>{title}</h3>
          <button
            type="button"
            className="tm-preview-icon-button"
            disabled={busy}
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>
        {onSubmit ? <form onSubmit={onSubmit}>{contents}</form> : contents}
      </div>
    </div>,
    document.body
  );
}

type Description = ConfigurationBindingsInspection['description'];
type DescribedService = Description['spec'] extends infer Spec
  ? Spec extends { type: 'environment'; services: infer Services }
    ? Services[keyof Services]
    : never
  : never;

/**
 * What runs and what it can reach, without environment values: the approval surface and the
 * read-only record of a past run. Folders are named for the person; exact paths sit under Access.
 */
export function PreviewRunReview({ description, projectDirectory, outcomes, sourceTargets, heading = 'What runs' }: {
  description: Description;
  projectDirectory?: string;
  /** The observed state of each service, for a run that already happened. */
  outcomes?: Record<string, ServiceStatus>;
  /** Desktop open targets for the run's source folders, by exact path. */
  sourceTargets?: Record<string, OpenTargetRef>;
  heading?: string;
}) {
  const spec = description.spec;
  const services: Array<[string, DescribedService | Description['spec']]> = description.compose
    ? description.compose.services.map((service) => [service.id, { type: 'compose' as const, image: service.image } as never])
    : spec.type === 'environment'
      ? Object.entries(spec.services)
      : [['Application', spec]];
  const probes = services.flatMap(([id, service]) =>
    (
      [
        ['readiness', 'ready' in service ? service.ready : undefined],
        ['health check', 'liveness' in service ? service.liveness?.probe : undefined]
      ] as const
    ).flatMap(([kind, probe]) => (probe?.type === 'command' ? [{ id, kind, probe }] : []))
  );
  const sources = [
    ...new Set([
      ...(spec.type === 'compose' ? [spec.cwd] : []),
      ...probes.flatMap(({ probe }) => (probe.cwd ? [probe.cwd] : [])),
      ...services.flatMap(([, service]) =>
        'cwd' in service && service.cwd ? [service.cwd] : 'directory' in service && service.directory ? [service.directory] : []
      )
    ])
  ];
  const inWorktree = (directory: string) =>
    !!projectDirectory && (directory === projectDirectory || directory.startsWith(`${projectDirectory}/`));
  const folder = (service: { cwd?: string; directory?: string }) => {
    const directory = service.cwd ?? service.directory;
    return directory ? folderName(directory, projectDirectory) : undefined;
  };
  return (
    <div className="tm-preview-run-review">
      <GroupLabel>{heading}</GroupLabel>
      <div className="tm-preview-rows">
        {services.map(([id, service]) => (
          <Row
            key={id}
            name={id}
            detail={'command' in service && service.command ? <code>{commandText(service.command)}</code> : <span>{serviceSummary(service)}</span>}
            end={outcomes?.[id] ? <StateWord service={outcomes[id]!} /> : undefined}
          >
            {[
              folder(service as { cwd?: string; directory?: string }),
              'dependsOn' in service && service.dependsOn?.length ? `after ${service.dependsOn.join(', ')}` : undefined,
              service.type === 'job' ? (service.run === 'once' ? 'once per retained environment' : 'every start') : undefined,
              readiness(service)
            ]
              .filter(Boolean)
              .join(' · ') || undefined}
          </Row>
        ))}
        {probes.map(({ id, kind, probe }) => (
          <Row key={`${id}:${kind}`} name={`${id} · ${kind}`} detail={<code>{commandText(probe.command)}</code>}>
            {probe.cwd ? folderName(probe.cwd, projectDirectory) : undefined}
          </Row>
        ))}
      </div>
      <GroupLabel>Access</GroupLabel>
      <div className="tm-preview-rows">
        {sources.map((source) => (
          <Row
            key={source}
            name={inWorktree(source) ? 'Task worktree' : 'External folder'}
            detail={<code title={source}>{inWorktree(source) ? shortenPath(source) : source}</code>}
            end={
              <>
                <CopyPath path={source} />
                {sourceTargets?.[source] ? <SourceFolderActions source={source} target={sourceTargets[source]!} /> : null}
              </>
            }
          />
        ))}
        {description.secrets?.map((secret) => (
          <Row
            key={secret.id}
            name={<code title={secret.id}>{secret.id}</code>}
            detail={secret.bindings.map((binding) => `${binding.service ?? 'Application'} → ${binding.key}`).join(', ')}
            end="Concealed value"
          />
        ))}
      </div>
    </div>
  );
}

function serviceSummary(service: DescribedService | Description['spec']): string {
  if (service.type === 'postgres' || service.type === 'redis')
    return `${serviceTypeLabel(service.type)} managed by Preview · data kept after Stop`;
  if (service.type === 'attach' && 'url' in service && service.url)
    return typeof service.url === 'string' ? service.url : 'secret' in service.url ? `Secret ${service.url.secret}` : `Environment ${service.url.fromEnv}`;
  if (service.type === 'external-tcp' && 'host' in service) return `${service.host}:${service.port}`;
  if (service.type === 'preview' && 'name' in service) return `Preview ${service.name}${service.service ? ` · ${service.service}` : ''}`;
  if ('image' in service && service.image) return `${serviceTypeLabel(service.type)} · ${service.image}`;
  if ('files' in service && Array.isArray(service.files)) return `Compose · ${service.files.join(', ')}`;
  return serviceTypeLabel(service.type);
}

function readiness(service: DescribedService | Description['spec']): string | undefined {
  if ('readyPath' in service && service.readyPath) return `ready at ${service.readyPath}`;
  const probe = 'ready' in service ? service.ready : undefined;
  if (!probe) return undefined;
  if (probe.type === 'command') return undefined;
  return probe.type === 'http' ? `ready at ${probe.path}` : `ready when port ${probe.port} accepts connections`;
}

export function commandText(command: string[]): string {
  return command
    .map((argument) =>
      /\s/.test(argument) ? JSON.stringify(argument) : argument
    )
    .join(' ');
}
