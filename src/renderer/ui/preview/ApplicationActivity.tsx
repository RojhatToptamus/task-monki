import { ApplicationSourceFolders } from './ApplicationSourceFolders';
import { DisclosureChevron } from '../DisclosureChevron';
import type { AttemptSummary, Failure, PreviewStatus } from 'previewhost';
import { label, ServiceName, serviceTypeLabel } from './previewPresentation';

export function ApplicationActivity({
  taskId,
  status,
  busy,
  onLogs,
  onRerun,
  onOpenSecrets,
  onConfigure
}: {
  taskId: string;
  status?: PreviewStatus;
  busy: boolean;
  onLogs(attemptId: string, source?: string): void;
  onRerun(attemptId: string, job: string): void;
  onOpenSecrets?(references: string[]): void;
  onConfigure(): void;
}) {
  const latest = status?.candidate ?? status?.latest;
  const attempts = [status?.active, latest].filter(
    (attempt, index, all): attempt is AttemptSummary =>
      !!attempt && all.findIndex((value) => value?.id === attempt.id) === index
  );
  const jobs = Object.entries(latest?.services ?? {}).filter(
    ([, value]) => value.type === 'job'
  );
  const failureShownInRow = Object.values(latest?.services ?? {}).some(
    (value) => value.error?.message === latest?.error?.message
  );
  const serviceAttempts = attempts.filter(
    (attempt) =>
      !(
        attempt.id !== status?.active?.id &&
        status?.active &&
        !status.candidate &&
        jobs.some(([, job]) => job.state === 'failed') &&
        !Object.values(attempt.services ?? {}).some(
          (service) => service.type !== 'job' && service.state === 'failed'
        )
      )
  );
  const retainedData = (status?.data?.resources ?? []).filter(
    (resource) =>
      !serviceAttempts.some(
        (attempt) => attempt.services?.[resource.name]?.type === resource.type
      )
  );
  return (
    <>
      {!attempts.length ? (
        <div className="tm-application-preview__empty">
          <p>Configure services and source folders to run this worktree.</p>
          <button className="primary-button" onClick={onConfigure}>
            Configure preview
          </button>
        </div>
      ) : null}
      {serviceAttempts.map((attempt) => {
        const serving = attempt.id === status?.active?.id;
        const services = Object.entries(attempt.services ?? {}).filter(
          ([, value]) => value.type !== 'job'
        );
        return (
          <section
            key={attempt.id}
            aria-label={serving ? 'Serving services' : 'Latest services'}
          >
            <h3 className="tm-panel__title tm-panel__title--flush">
              Services ·{' '}
              {serving
                ? 'Serving'
                : status?.candidate?.id === attempt.id
                  ? 'Starting'
                  : 'Latest attempt'}
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
                    services.map(([id, value]) => (
                      <tr key={id}>
                        <th scope="row">
                          <ServiceName name={id} type={value.type} />
                          {value.error ? (
                            <p className="tm-application-preview__error">
                              {diagnostic(value.error, value.type)}
                            </p>
                          ) : null}
                        </th>
                        <td>{serviceTypeLabel(value.type)}</td>
                        <td>
                          <span
                            className="tm-application-preview__state"
                            data-state={value.state}
                          >
                            {label(value.state)}
                          </span>
                        </td>
                        <td
                          className="tm-application-preview__endpoint"
                          title={value.browserUrl}
                        >
                          <span>
                            {value.waitingFor?.length
                              ? `Waiting for ${value.waitingFor.join(', ')}`
                              : ((serving && value.state === 'ready'
                                  ? value.browserUrl?.replace(
                                      `${status?.name}--`,
                                      '…--'
                                    )
                                  : undefined) ??
                                (status?.data?.resources.some(
                                  (resource) =>
                                    resource.name === id &&
                                    resource.type === value.type
                                )
                                  ? 'Data retained'
                                  : '—'))}
                          </span>
                        </td>
                        <td>
                          {['command', 'worker', 'compose'].includes(
                            value.type
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
                      <td>
                        <span
                          className="tm-application-preview__state"
                          data-state={attempt.state}
                        >
                          {label(attempt.state)}
                        </span>
                      </td>
                      <td className="tm-application-preview__endpoint">
                        {serving ? status?.url : '—'}
                      </td>
                      <td>
                        {attempt.type === 'command' ? (
                          <button
                            className="ghost-button"
                            onClick={() => onLogs(attempt.id)}
                          >
                            Logs
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {attempt.sources?.length ? (
              <ApplicationSourceFolders taskId={taskId} attemptId={attempt.id} sources={attempt.sources} />
            ) : null}
          </section>
        );
      })}
      {retainedData.length ? (
        <section aria-label="Retained data">
          <h3 className="tm-panel__title tm-panel__title--flush">Retained data</h3>
          <div className="tm-application-preview__table-wrap">
            <table className="tm-application-preview__table">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Type</th>
                  <th scope="col">Data</th>
                </tr>
              </thead>
              <tbody>
                {retainedData.map((resource) => (
                  <tr key={resource.name}>
                    <th scope="row">
                      <ServiceName name={resource.name} type={resource.type} />
                    </th>
                    <td>{serviceTypeLabel(resource.type)}</td>
                    <td>Retained</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {status?.data?.cleanup ? (
        <p role="alert" className="tm-application-preview__error">
          {status.data.cleanup.message}
        </p>
      ) : null}
      {jobs.length && latest ? (
        <section aria-label="Setup jobs">
          <h3 className="tm-panel__title tm-panel__title--flush">
            Setup jobs ·{' '}
            {latest.id === status?.active?.id ? 'Serving' : 'Latest attempt'}
          </h3>
          <div className="tm-application-preview__table-wrap">
            <table className="tm-application-preview__table">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="tm-visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(([id, job]) => (
                  <tr key={id}>
                    <th scope="row">
                      <ServiceName name={id} type="job" />
                      {job.error ? (
                        <p className="tm-application-preview__error">
                          {diagnostic(job.error)}
                        </p>
                      ) : null}
                    </th>
                    <td>
                      <span
                        className="tm-application-preview__state"
                        data-state={job.state}
                      >
                        {label(job.state)}
                      </span>
                    </td>
                    <td>
                      <div className="tm-application-preview__toolbar">
                        {!status?.active &&
                        !status?.candidate &&
                        ['failed', 'canceled'].includes(job.state) ? (
                          <button
                            className="outline-button"
                            disabled={busy || status?.busy}
                            onClick={() => onRerun(latest.id, id)}
                          >
                            Rerun
                          </button>
                        ) : null}
                        <button
                          className="ghost-button"
                          aria-label={`Logs for ${id}`}
                          onClick={() => onLogs(latest.id, id)}
                        >
                          Logs
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {status?.active && jobs.some(([, job]) => job.state === 'failed') ? (
            <p className="tm-application-preview__notice">
              Stop the preview to rerun a failed job.
            </p>
          ) : null}
        </section>
      ) : null}
      {latest?.error && !failureShownInRow ? (
        <div className="tm-application-preview__feedback">
          <p role="alert" className="form-error">
            {latest.error.code === 'SOURCE_DENIED'
              ? 'Source access needs approval.'
              : latest.error.code === 'SECRET_STORE_UNAVAILABLE'
                ? 'Unlock or create secret storage, then start again.'
                : diagnostic(latest.error)}
          </p>
          <button className="outline-button" onClick={() => onLogs(latest.id)}>View attempt logs</button>
          {latest.error.requirements?.map(secret => <p key={secret.id}><code>{secret.id}</code> — {secret.bindings.map(binding => `${binding.service ?? 'Application'} → ${binding.key}`).join(', ')}</p>)}
          {latest.error.code === 'SOURCE_DENIED' ? (
            <>
              <button className="outline-button" onClick={onConfigure}>
                Connect source folder
              </button>
              <details className="tm-application-preview__technical">
                <summary>
                  <DisclosureChevron />
                  Details
                </summary>
                <p>{latest.error.message}</p>
              </details>
            </>
          ) : null}
        </div>
      ) : null}
      {latest?.error &&
      ['SECRET_STORE_UNAVAILABLE', 'SECRET_REQUIRED', 'SECRET_DENIED'].includes(
        latest.error.code
      ) &&
      onOpenSecrets ? (
        <div className="tm-application-preview__feedback">
          <button
            className="outline-button"
            onClick={() =>
              onOpenSecrets(
                latest.error?.requirements?.map((value) => value.id) ?? []
              )
            }
          >
            Resolve secrets
          </button>
        </div>
      ) : null}
    </>
  );
}

function diagnostic(error: Failure, type?: string) {
  if (error.code === 'SUPERVISOR_FAILED') return `${error.message} Task Monki's preview runtime could not start. View logs for the missing module or process error, then rebuild or reinstall Task Monki.`;
  if (error.code === 'TIMEOUT') return `${error.message} Check this service's logs and readiness settings.`;
  if (error.code === 'START_FAILED' && type && ['postgres', 'redis', 'compose'].includes(type)) return `${error.message} Check Docker and this service's logs before retrying.`;
  if (error.code === 'START_FAILED' && type && ['attach', 'preview', 'external-tcp', 'external-postgres', 'external-redis'].includes(type)) return `${error.message} Check the dependency's local endpoint and credentials before retrying.`;
  if (error.code === 'START_FAILED') return `${error.message} Check the command, installed project dependencies, and logs before retrying.`;
  return error.message;
}
