import type { AttemptSummary, PreviewStatus, ServiceStatus } from 'previewhost';
import { previewAddress, previewRunRows, type PreviewAddress } from '../../model/applicationPreviewRuns';
import { PreviewAddressActions } from './PreviewAddress';
import { clock, GroupLabel, Row, serviceTypeLabel, StateWord } from './previewPresentation';

const hasLogs = (service: Pick<ServiceStatus, 'type'>) => ['command', 'worker', 'job', 'compose'].includes(service.type);

/**
 * The record of what is running and what ran: the services of the current run, its setup steps,
 * data kept across stops, and the runs themselves. The table keeps one shape in every state so
 * nothing jumps when a run becomes ready.
 */
export function ApplicationActivity({ status, restoredRun, onLogs, onAsRun, onConfigureLogs, onOpenAddress }: {
  status?: PreviewStatus;
  /** Opens a serving address; without it addresses are text with their copy menu. */
  onOpenAddress?(address: PreviewAddress): void;
  restoredRun?: boolean;
  onLogs(attemptId: string, source?: string, failure?: boolean): void;
  onAsRun(attempt: AttemptSummary): void;
  onConfigureLogs?(services: string[]): void;
}) {
  const attempt = status?.candidate ?? status?.latest ?? status?.active;
  if (!attempt) return <p className="tm-application-preview__empty">No runs yet.</p>;
  const entries = Object.entries(attempt.services ?? {});
  const services = entries.filter(([, service]) => service.type !== 'job');
  const external = entries.filter(([, service]) => service.type === 'attach' || service.type.startsWith('external-')).map(([id]) => id);
  const jobs = entries.filter(([, service]) => service.type === 'job');
  const serving = status?.active?.id === attempt.id;
  const retained = (name: string) => status?.data?.resources.some((resource) => resource.name === name);
  const unlisted = status?.data?.resources.filter((resource) => !entries.some(([id]) => id === resource.name)) ?? [];
  const runs = previewRunRows(status, !!restoredRun);
  // An environment whose services expired with the runtime has nothing to tabulate.
  const showTable = entries.length > 0 || attempt.type !== 'environment';
  const logsFor = (id: string | undefined, service: Pick<ServiceStatus, 'type' | 'state'>) =>
    hasLogs(service) ? (
      <button className="ghost-button" aria-label={`Logs for ${id ?? 'the application'}`} onClick={() => onLogs(attempt.id, id, service.state === 'failed')}>
        Logs
      </button>
    ) : null;
  return (
    <>
      {showTable ? (
        <section aria-label="Preview services">
          <GroupLabel>
            Services
            <span className="tm-preview-group__meta"> · {serving ? 'serving' : attempt === status?.candidate ? 'starting' : 'last run'} <time dateTime={attempt.startedAt}>{clock(attempt.startedAt)}</time></span>
          </GroupLabel>
          <div className="tm-application-preview__table-wrap">
            <table className="tm-application-preview__table tm-application-preview__services">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Address</th>
                  <th scope="col"><span className="tm-visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {(services.length || jobs.length ? services : [['Application', { type: attempt.type, state: attempt.state } as ServiceStatus] as const]).map(([id, service]) => {
                  const address = serving ? previewAddress(status, id === 'Application' ? undefined : id) : undefined;
                  return (
                    <tr key={id}>
                      <th scope="row"><span className="tm-application-preview__service-name" title={id}>{id}</span></th>
                      <td>{serviceTypeLabel(service.type)}</td>
                      <td><StateWord service={service} /></td>
                      <td className="tm-application-preview__endpoint">
                        {address ? (
                          <PreviewAddressActions name={id} address={address} onOpen={onOpenAddress} />
                        ) : retained(id) ? 'Data kept' : null}
                      </td>
                      <td>{logsFor(id === 'Application' ? undefined : id, service)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {external.length ? (
            <p className="tm-preview-help">
              {external.join(', ')} {external.length === 1 ? 'runs' : 'run'} outside Preview. Logs stay with the process that started each service.
              {onConfigureLogs ? <> <button className="ghost-button" onClick={() => onConfigureLogs(external)}>Ask agent to enable logs</button></> : null}
            </p>
          ) : null}
        </section>
      ) : null}
      {jobs.length ? (
        <section aria-label="Setup steps">
          <GroupLabel>Setup steps</GroupLabel>
          <div className="tm-preview-rows">
            {jobs.map(([id, service]) => (
              <Row key={id} name={id} detail={<StateWord service={service} />} end={logsFor(id, service)} />
            ))}
          </div>
        </section>
      ) : null}
      {unlisted.length ? (
        <section aria-label="Retained data">
          <GroupLabel>Retained data</GroupLabel>
          <div className="tm-preview-rows">
            {unlisted.map((resource) => (
              <Row key={resource.name} name={resource.name} detail={`${serviceTypeLabel(resource.type)} · data kept across Stop`} />
            ))}
          </div>
        </section>
      ) : null}
      <section aria-label="Preview runs">
        <GroupLabel>Runs</GroupLabel>
        <div className="tm-preview-runs">
          {runs.map((run) => (
            <div className="tm-preview-run" key={run.attempt.id}>
              <span className="tm-preview-run__when">{run.time}</span>
              <span className="tm-preview-run__outcome">
                {run.outcome}
                {run.cause ? <span className="tm-preview-run__cause"> · {run.cause}</span> : null}
              </span>
              <span className="tm-preview-run__end">
                {run.logsAvailable ? (
                  <button className="ghost-button" aria-label={`Logs for the run at ${run.time}`} onClick={() => onLogs(run.attempt.id, undefined, run.attempt.state === 'failed')}>
                    Logs
                  </button>
                ) : null}
                <button className="ghost-button" aria-label={`Run configuration at ${run.time}`} onClick={() => onAsRun(run.attempt)}>
                  Run configuration
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
