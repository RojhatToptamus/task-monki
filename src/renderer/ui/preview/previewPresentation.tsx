import {
  useLayoutEffect,
  useRef,
  type FormEventHandler,
  type ReactNode,
  type RefObject
} from 'react';
import { DisclosureChevron } from '../DisclosureChevron';
import {
  Box,
  Database,
  FileCode2,
  Layers,
  Link,
  Terminal,
  X
} from 'lucide-react';
import { createPortal } from 'react-dom';
import type {
  ConfigurationBindingsInspection,
  PreviewStatus
} from 'previewhost';
import { useDialogFocusBoundary } from '../dialogFocus';

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
export const label = (state: string) =>
  state.replaceAll('-', ' ').replace(/^./, (value) => value.toUpperCase());

export function ServiceName({ name, type }: { name: string; type: string }) {
  const Icon =
    type === 'postgres' || type === 'external-postgres'
      ? Database
      : type === 'redis' || type === 'external-redis'
        ? Layers
        : type === 'static'
          ? FileCode2
          : type === 'compose'
            ? Box
            : ['attach', 'preview', 'external-tcp'].includes(type)
              ? Link
              : Terminal;
  return (
    <span className="tm-application-preview__service-name">
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
      <span title={name}>{name}</span>
    </span>
  );
}

export function serviceTypeLabel(type: string): string {
  if (type === 'command') return 'HTTP';
  if (type === 'postgres' || type === 'external-postgres') return 'PostgreSQL';
  if (type === 'external-redis') return 'Redis';
  if (type === 'attach') return 'Attached HTTP';
  return label(type);
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

/** The approval surface shows commands and access without exposing environment values. */
export function PreviewRunReview({
  description
}: {
  description: ConfigurationBindingsInspection['description'];
}) {
  const spec = description.spec;
  const services =
    spec.type === 'environment'
      ? Object.entries(spec.services)
      : [['Application', spec] as const];
  const probes = services.flatMap(([id, service]) => {
    const candidates = [
      ['readiness', 'ready' in service ? service.ready : undefined],
      [
        'health check',
        'liveness' in service ? service.liveness?.probe : undefined
      ]
    ] as const;
    return candidates.flatMap(([kind, probe]) =>
      probe?.type === 'command' ? [{ id, kind, probe }] : []
    );
  });
  const sources = [
    ...new Set([
      ...probes.flatMap(({ probe }) => (probe.cwd ? [probe.cwd] : [])),
      ...services.flatMap(([, service]) =>
        'cwd' in service && service.cwd
          ? [service.cwd]
          : 'directory' in service && service.directory
            ? [service.directory]
            : []
      )
    ])
  ];
  return (
    <div className="tm-preview-run-review">
      <h4 className="tm-panel__title">What runs</h4>
      {services.map(([id, service]) => (
        <div className="tm-preview-detail-row" key={id}>
          <strong>{id}</strong>
          <div>
            {'command' in service && service.command ? (
              <code>{commandText(service.command)}</code>
            ) : (
              <span>
                {service.type === 'postgres' || service.type === 'redis'
                  ? `${serviceTypeLabel(service.type)} managed by Preview · data kept after Stop`
                  : service.type === 'attach' && service.url
                    ? typeof service.url === 'string'
                      ? service.url
                      : 'secret' in service.url
                        ? `Secret: ${service.url.secret}`
                        : `Environment: ${service.url.fromEnv}`
                    : serviceTypeLabel(service.type)}
              </span>
            )}
            {'dependsOn' in service && service.dependsOn?.length ? (
              <small>After {service.dependsOn.join(', ')}</small>
            ) : null}
            {service.type === 'job' ? (
              <small>
                {service.run === 'once'
                  ? 'Once per retained environment'
                  : 'Runs on every start'}
              </small>
            ) : null}
          </div>
          <span>
            {'cwd' in service && service.cwd
              ? service.cwd.split('/').at(-1)
              : 'directory' in service
                ? 'Static files'
                : ''}
          </span>
        </div>
      ))}
      {probes.map(({ id, kind, probe }) => (
        <div className="tm-preview-detail-row" key={`${id}:${kind}`}>
          <strong>
            {id} · {kind}
          </strong>
          <code>{commandText(probe.command)}</code>
          <span>{probe.cwd?.split('/').at(-1)}</span>
        </div>
      ))}
      <h4 className="tm-panel__title">Access</h4>
      {sources.map((source) => (
        <div className="tm-preview-detail-row" key={source}>
          <strong>Source folder</strong>
          <code>{source}</code>
          <button
            className="ghost-button"
            onClick={() => void navigator.clipboard.writeText(source)}
          >
            Copy path
          </button>
        </div>
      ))}
      {description.secrets?.map((secret) => (
        <div className="tm-preview-detail-row" key={secret.id}>
          <code title={secret.id}>{secret.id}</code>
          <span>
            {secret.bindings
              .map(
                (binding) =>
                  `${binding.service ?? 'Application'} → ${binding.key}`
              )
              .join(', ')}
          </span>
          <span>Concealed value</span>
        </div>
      ))}
      <details className="tm-preview-disclosure">
        <summary>
          <DisclosureChevron />
          Technical details
        </summary>
        <ConfigurationDefinitions description={description} />
      </details>
    </div>
  );
}

export function ConfigurationDefinitions({
  description,
  showSecrets = true
}: {
  description: ConfigurationBindingsInspection['description'];
  showSecrets?: boolean;
}) {
  const spec = description.spec;
  const services = description.compose
    ? description.compose.services.map(
        (value) =>
          [
            value.id,
            {
              ...value,
              type: 'compose' as const,
              cwd: spec.type === 'compose' ? spec.cwd : undefined
            }
          ] as const
      )
    : spec.type === 'environment'
      ? Object.entries(spec.services)
      : [['Application', spec] as const];
  const sources = [
    ...new Set(
      services.flatMap(([, value]) =>
        'cwd' in value && value.cwd
          ? [value.cwd]
          : 'directory' in value
            ? [value.directory]
            : []
      )
    )
  ];
  return (
    <div className="tm-application-preview__definitions">
      <ul className="tm-application-preview__definition-list">
        {services.map(([id, value]) => (
          <li key={id}>
            <div className="tm-application-preview__definition-heading">
              <strong>
                <ServiceName name={id} type={value.type} />
              </strong>
              <span>{serviceTypeLabel(value.type)}</span>
            </div>
            {'command' in value && value.command ? (
              <code className="tm-application-preview__command">
                {commandText(value.command)}
              </code>
            ) : null}
            {value.type === 'attach' && value.url ? (
              <code>
                {typeof value.url === 'string'
                  ? value.url
                  : 'secret' in value.url
                    ? `Secret: ${value.url.secret}`
                    : `Environment: ${value.url.fromEnv}`}
              </code>
            ) : value.type === 'preview' ? (
              <span>
                Preview: {value.name}
                {value.service ? ` · ${value.service}` : ''}
              </span>
            ) : value.type === 'external-tcp' ? (
              <code>
                {value.host}:{value.port}
              </code>
            ) : null}
            {'image' in value && value.image ? (
              <code>{value.image}</code>
            ) : null}
            {'files' in value ? <span>{value.files.join(', ')}</span> : null}
            {'dependsOn' in value && value.dependsOn?.length ? (
              <small>
                After{' '}
                {value.dependsOn
                  .map((dependency) =>
                    typeof dependency === 'string'
                      ? dependency
                      : dependency.service
                  )
                  .join(', ')}
              </small>
            ) : null}
            {('cwd' in value && value.cwd) ||
            'directory' in value ||
            ('ready' in value && value.ready) ||
            'readyPath' in value ? (
              <details className="tm-application-preview__technical">
                <summary>
                  <DisclosureChevron />
                  Details
                </summary>
                {'cwd' in value && value.cwd ? (
                  <div>
                    Working folder<code>{value.cwd}</code>
                  </div>
                ) : null}
                {'directory' in value ? (
                  <div>
                    Served folder<code>{value.directory}</code>
                  </div>
                ) : null}
                {'ready' in value && value.ready ? (
                  <div>
                    Readiness
                    <code>
                      {value.ready.type === 'command'
                        ? commandText(value.ready.command)
                        : `${value.ready.type.toUpperCase()} ${value.ready.port}${value.ready.type === 'http' ? ` ${value.ready.path}` : ''}`}
                    </code>
                  </div>
                ) : 'readyPath' in value ? (
                  <div>
                    Readiness<code>{value.readyPath}</code>
                  </div>
                ) : null}
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      {sources.length ? (
        <details open className="tm-application-preview__sources">
          <summary>
            <DisclosureChevron />
            Source access · {sources.length}{' '}
            {sources.length === 1 ? 'folder' : 'folders'}
          </summary>
          {sources.map((source) => (
            <code key={source} title={source}>
              {source}
            </code>
          ))}
        </details>
      ) : null}
      {showSecrets && description.secrets?.length ? (
        <div className="tm-application-preview__secret-references">
          <h4>Secret references</h4>
          {description.secrets.map((secret) => (
            <code key={secret.id}>{secret.id}</code>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function commandText(command: string[]): string {
  return command
    .map((argument) =>
      /\s/.test(argument) ? JSON.stringify(argument) : argument
    )
    .join(' ');
}
