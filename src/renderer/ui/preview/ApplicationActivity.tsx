import { useState } from 'react';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import type { PreviewDescription } from 'previewhost';
import { ConfigurationDefinitions, message } from './previewPresentation';
import type { AttemptSummary, PreviewStatus } from 'previewhost';
import { ApplicationSourceFolders } from './ApplicationSourceFolders';
import { label, ServiceName, serviceTypeLabel } from './previewPresentation';
import { Chip } from '../StatusBadge';

export function applicationAttempts(status?: PreviewStatus): AttemptSummary[] {
  return [
    status?.candidate,
    status?.latest,
    status?.active,
    ...(status?.history ?? [])
  ]
    .filter(
      (item, index, all): item is AttemptSummary =>
        !!item && all.findIndex((other) => other?.id === item.id) === index
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export function runLabel(attempt: AttemptSummary, status?: PreviewStatus) {
  const date = new Date(attempt.startedAt);
  const time = Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'Last run';
  return `${time} · ${status?.active?.id === attempt.id ? 'serving' : attempt.state}`;
}

export function ApplicationActivity({
  taskId,
  status,
  restoredRun,
  onLogs
}: {
  taskId: string;
  status?: PreviewStatus;
  restoredRun?: boolean;
  onLogs(attemptId: string, source?: string): void;
}) {
  const attempt = status?.candidate ?? status?.latest ?? status?.active;
  const attempts = applicationAttempts(status);
  if (!attempt)
    return <p className="tm-application-preview__empty">No runs yet.</p>;
  const services = Object.entries(attempt.services ?? {});
  const serving = status?.active?.id === attempt.id;
  return (
    <>
      <section aria-label="Preview services">
        <h3 className="tm-panel__title">
          Services{!serving && status?.active ? ' · latest attempt' : ''}
        </h3>
        <div className="tm-application-preview__table-wrap">
          <table className="tm-application-preview__table tm-application-preview__services">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Address / data</th>
                <th scope="col">
                  <span className="tm-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {services.length ? (
                services.map(([id, service]) => (
                  <tr key={id}>
                    <th scope="row">
                      <ServiceName name={id} type={service.type} />
                    </th>
                    <td>{serviceTypeLabel(service.type)}</td>
                    <td>
                      <span
                        className="tm-application-preview__state"
                        data-state={service.state}
                      >
                        {service.state === 'skipped'
                          ? 'Not started'
                          : label(service.state)}
                      </span>
                    </td>
                    <td className="tm-application-preview__endpoint">
                      {serving && service.browserUrl
                        ? service.browserUrl
                        : status?.data?.resources.some(
                              (resource) => resource.name === id
                            )
                          ? 'Data retained'
                          : service.waitingFor?.length
                            ? `Waiting for ${service.waitingFor.join(', ')}`
                            : '—'}
                    </td>
                    <td>
                      {['command', 'worker', 'job', 'compose'].includes(
                        service.type
                      ) ? (
                        <button
                          className="ghost-button"
                          aria-label={`Logs for ${id}`}
                          onClick={() => onLogs(attempt.id, id)}
                        >
                          Logs
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <th scope="row">
                    <ServiceName name="Application" type={attempt.type} />
                  </th>
                  <td>{serviceTypeLabel(attempt.type)}</td>
                  <td>{label(attempt.state)}</td>
                  <td>{serving ? status?.url : '—'}</td>
                  <td>
                    {attempt.type !== 'static' ? (
                      <button
                        className="ghost-button"
                        onClick={() => onLogs(attempt.id)}
                      >
                        Logs
                      </button>
                    ) : null}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {status?.data?.resources.some(
        (resource) => !services.some(([id]) => id === resource.name)
      ) ? (
        <section aria-label="Retained data">
          <h3 className="tm-panel__title">Retained data</h3>
          {status.data.resources
            .filter(
              (resource) => !services.some(([id]) => id === resource.name)
            )
            .map((resource) => (
              <p key={resource.name}>
                <strong>{resource.name}</strong> ·{' '}
                {serviceTypeLabel(resource.type)} · Data retained
              </p>
            ))}
        </section>
      ) : null}
      <section aria-label="Preview runs">
        <h3 className="tm-panel__title">Runs · {attempts.length}</h3>
        {attempts.map((item) => (
          <div className="tm-preview-run" key={item.id}>
            <span>
              {restoredRun && item.id === status?.latest?.id
                ? 'Last run · stopped when Task Monki quit · logs expired'
                : runLabel(item, status)}
            </span>
            {item.id === status?.active?.id ? (
              <Chip label="Serving" tone="success" />
            ) : null}
            <button
              className="ghost-button"
              aria-label={`Logs for run ${runLabel(item, status)}`}
              onClick={() => onLogs(item.id)}
            >
              Logs
            </button>
            <AsRun taskId={taskId} attempt={item} />
          </div>
        ))}
      </section>
    </>
  );
}

function AsRun({
  taskId,
  attempt
}: {
  taskId: string;
  attempt: AttemptSummary;
}) {
  const [description, setDescription] = useState<PreviewDescription>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  async function inspect() {
    if (description || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      setDescription(
        (
          await api.inspectApplicationPreviewConfiguration({
            taskId,
            attemptId: attempt.id,
            changes: []
          })
        ).description
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }
  return (
    <details
      className="tm-preview-disclosure"
      onToggle={(event) => {
        if (event.currentTarget.open) void inspect();
      }}
    >
      <summary>As run</summary>
      {loading ? <p>Reading configuration…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {description ? (
        <ConfigurationDefinitions description={description} />
      ) : null}
      <ApplicationSourceFolders
        taskId={taskId}
        attemptId={attempt.id}
        sources={attempt.sources}
      />
    </details>
  );
}
