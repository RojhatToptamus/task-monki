import type { AttemptSummary, PreviewStatus, ServiceStatus } from 'previewhost';

/** Every attempt the runtime still knows, newest first, each once. */
export function applicationAttempts(status?: PreviewStatus): AttemptSummary[] {
  return [status?.candidate, status?.latest, status?.active, ...(status?.history ?? [])]
    .filter((item, index, all): item is AttemptSummary => !!item && all.findIndex((other) => other?.id === item.id) === index)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export interface PreviewRunRow {
  attempt: AttemptSummary;
  /** Clock time today, otherwise the day as well. */
  time: string;
  /** What happened, in ink: "Current run · serving", "Failed", "Stopped when Task Monki quit". */
  outcome: string;
  /** What decided it, muted: the failing service and its exit, or "logs expired". */
  cause?: string;
  /** Logs are readable only while the runtime that produced them is alive. */
  logsAvailable: boolean;
}

/** The runs list: time, outcome, cause. Attempt ids never appear. */
export function previewRunRows(status: PreviewStatus | undefined, restoredRun: boolean, now = new Date()): PreviewRunRow[] {
  return applicationAttempts(status).map((attempt) => {
    const restored = restoredRun && attempt.id === status?.latest?.id;
    const serving = attempt.id === status?.active?.id;
    // A failure that started while an earlier run was already serving is a failed update of it.
    const update = !!status?.active && !serving && attempt.startedAt > status.active.startedAt;
    return {
      attempt,
      time: runTime(attempt.startedAt, now),
      outcome: restored
        ? 'Stopped when Task Monki quit'
        : serving
          ? `Current run · ${readyIn(attempt)}serving`
          : attempt.state === 'failed'
            ? update ? 'Update failed' : 'Failed'
            : attempt.state === 'starting'
              ? 'This run · starting'
              : attempt.state === 'canceled'
                ? 'Canceled'
                : attempt.state === 'cleanup-incomplete'
                  ? 'Stopped · cleanup incomplete'
                  : 'Stopped',
      cause: restored ? 'logs expired' : failureCause(attempt),
      logsAvailable: !restored
    };
  });
}

function readyIn(attempt: AttemptSummary): string {
  if (!attempt.readyAt) return '';
  const seconds = Math.round((Date.parse(attempt.readyAt) - Date.parse(attempt.startedAt)) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? `ready in ${seconds} s · ` : '';
}

/** The failing service and the fact the runtime reported for it. */
export function failureCause(attempt: AttemptSummary): string | undefined {
  const failed = Object.entries(attempt.services ?? {}).find(([, service]) => service.state === 'failed');
  if (failed) return `${failed[0]} ${failureDetail(failed[1].error?.message)}`;
  return attempt.state === 'failed' ? failureDetail(attempt.error?.message) : undefined;
}

function failureDetail(message: string | undefined): string {
  const exit = exitCode(message);
  if (exit !== undefined) return `exited with code ${exit}`;
  if (message && /did not become ready|timed out|timeout/i.test(message)) return 'did not become ready in time';
  return message ? message.replace(/\.$/, '') : 'failed';
}

export function exitCode(message: string | undefined): string | undefined {
  return (message?.match(/exit(?:ed)?(?: with)?(?: code)? (\d+)/i) ?? message?.match(/\bcode (\d+)/i))?.[1];
}

/** The state word for one service in a table or row, with the fact that decided it. */
export function serviceOutcome(service: Pick<ServiceStatus, 'type' | 'state' | 'waitingFor' | 'error'>): { word: string; detail?: string } {
  switch (service.state) {
    case 'waiting':
      return { word: 'Waiting', detail: service.waitingFor?.length ? `after ${service.waitingFor.join(', ')}` : undefined };
    case 'starting':
      return { word: service.type === 'job' ? 'Running' : 'Starting' };
    case 'ready':
      return { word: 'Ready' };
    case 'succeeded':
      return { word: 'Done' };
    case 'skipped':
      return { word: 'Not started' };
    case 'failed': {
      const exit = exitCode(service.error?.message);
      return { word: 'Failed', detail: exit !== undefined ? `exit ${exit}` : service.error?.message && /did not become ready|timed out|timeout/i.test(service.error.message) ? 'not ready in time' : undefined };
    }
    case 'canceled':
      return { word: 'Canceled' };
    default:
      return { word: 'Stopped' };
  }
}

/**
 * The address a serving service answers on: its routed host name (`tm-<id>--api.localhost:port`),
 * which is what the browser must use for the app's own origins and CORS. Only a single-application
 * preview without a routed name falls back to the router's numeric address.
 */
export interface PreviewAddress {
  url: string;
  /** Short enough for a table cell, still the real host: `tm-6ef7…--api.localhost:62492`. */
  text: string;
  /** The service the runtime opens; absent for a single-application preview. */
  service?: string;
}

/** The address of one serving service, or of the application when `service` is omitted. */
export function previewAddress(status: PreviewStatus | undefined, service?: string): PreviewAddress | undefined {
  if (!status?.active || !status.url) return undefined;
  const url = service ? status.active.services?.[service]?.browserUrl : status.url;
  return url ? { url, text: shortAddress(url), ...(service ? { service } : {}) } : undefined;
}

/** The service that answers on the preview's own address, when the run is an environment. */
export function primaryService(status: PreviewStatus | undefined): string | undefined {
  return Object.entries(status?.active?.services ?? {}).find(([, service]) => !!status?.url && service.url === status.url)?.[0];
}

/** Host and port, with the runtime's route id shortened but kept: the text must still name the real host. */
export function shortAddress(url: string): string {
  try {
    return new URL(url).host.replace(/^(tm-[0-9a-f]{4})[0-9a-f-]*--/i, '$1…--');
  } catch {
    return url;
  }
}

/** Today's runs by clock; earlier ones say the day. */
export function runTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, now)) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday ${clock}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
}
