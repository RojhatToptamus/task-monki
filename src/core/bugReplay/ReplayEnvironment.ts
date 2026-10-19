import { PreviewError, type PreviewRuntime, type PreviewSpec, type PreviewStatus } from 'previewhost';
import { REPLAY_NAME_PATTERN } from './ReplayDerivation';
import type { ReplayAuthorization } from './ReplayAuthorization';
import { isGatewaySignature } from './runner/protocol';

/**
 * One clean environment on the shared Previewhost runtime: a never-reused `br-` name, started
 * from a frozen export on fresh managed data, watched until ready, bracketed while the runner
 * works, and torn down completely (stop, delete data, forget the name) afterwards.
 */

export interface StartedReplayEnvironment {
  attemptId: string;
  /** Origin role → origin: 'primary' is the numeric public URL, `s-<service>` each browser alias. */
  origins: Record<string, string>;
  readyAt: string;
  jobs: Array<{ id: string; state: string }>;
}

export class ReplayEnvironmentError extends Error {
  constructor(
    readonly code: 'NOT_CLEAN' | 'START_FAILED' | 'PREREQUISITE' | 'CAPACITY' | 'AUTHORIZATION' | 'CANCELED',
    message: string,
    readonly service?: string
  ) {
    super(message);
    this.name = 'ReplayEnvironmentError';
  }
}

export interface ReplayCapacity {
  ok: boolean;
  reason?: string;
}

const LIVE_NAME_HEADROOM = 4;
const RETAINED_RECORD_HEADROOM = 8;

export class ReplayEnvironment {
  constructor(
    private readonly runtime: () => PreviewRuntime,
    private readonly authorization: ReplayAuthorization
  ) {}

  /** Checks Docker and images before anything starts; Previewhost never pulls images. */
  async preflight(spec: PreviewSpec): Promise<void> {
    const description = await this.runtime().inspect(spec);
    const blocking = (description.prerequisites ?? []).find(
      (finding) => finding.status === 'missing' && (finding.requirement === 'docker' || finding.requirement === 'image' || finding.requirement === 'executable')
    );
    if (blocking) throw new ReplayEnvironmentError('PREREQUISITE', blocking.message, blocking.service);
  }

  /** Leaves headroom in the runtime's shared limits so ordinary previews keep working. */
  async capacity(serviceCount: number): Promise<ReplayCapacity> {
    const statuses = await this.runtime().list();
    const live = statuses.filter((status) => status.active || status.candidate || status.busy);
    if (live.length >= 32 - LIVE_NAME_HEADROOM) return { ok: false, reason: 'Waiting for preview capacity' };
    if (statuses.length >= 128 - RETAINED_RECORD_HEADROOM) return { ok: false, reason: 'Waiting for preview capacity' };
    const liveNodes = live.reduce((sum, status) => sum + Object.keys((status.active ?? status.candidate)?.services ?? {}).length + 1, 0);
    if (liveNodes + serviceCount + 1 > 120) return { ok: false, reason: 'Waiting for preview capacity' };
    return { ok: true };
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.runtime().get(name);
      return true;
    } catch (error) {
      if (error instanceof PreviewError && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  /**
   * Starts the environment under its fresh name and waits until it is ready. A job reported as
   * skipped proves the name had retained state, so the run is not a clean start.
   */
  async start(input: {
    taskId: string;
    name: string;
    spec: PreviewSpec;
    approvalDigest: string;
    secretIds: string[];
    signal: AbortSignal;
    onPhase?: (phase: string) => void;
    /** Every second while starting: each service of the attempt and its state, in the recipe's order. */
    onServices?: (services: Array<{ id: string; type: string; state: string }>) => void;
    onAttempt?: (attemptId: string) => void;
  }): Promise<StartedReplayEnvironment> {
    if (!REPLAY_NAME_PATTERN.test(input.name) || input.spec.name !== input.name) throw new Error('A replay must start under its own br- name.');
    if (input.signal.aborted) throw new ReplayEnvironmentError('CANCELED', 'Canceled');
    if (await this.exists(input.name)) throw new ReplayEnvironmentError('NOT_CLEAN', 'The clean copy found data an earlier run left under its name.');
    // Canceled while the name was checked: nothing has started yet.
    if (input.signal.aborted) throw new ReplayEnvironmentError('CANCELED', 'Canceled');
    this.authorization.expectStart(input.name, {
      taskId: input.taskId,
      approvalDigest: input.approvalDigest,
      spec: input.spec,
      secretIds: input.secretIds
    });
    let status: PreviewStatus;
    try {
      status = await this.runtime().start(input.spec);
    } catch (error) {
      this.authorization.cancelStart(input.name);
      if (error instanceof PreviewError && error.code === 'BUSY') throw new ReplayEnvironmentError('CAPACITY', 'Waiting for preview capacity');
      throw new ReplayEnvironmentError('START_FAILED', errorMessage(error));
    }
    const attemptId = status.candidate?.id ?? status.latest?.id;
    if (!attemptId) throw new ReplayEnvironmentError('START_FAILED', 'Preview did not report the new attempt.');
    input.onAttempt?.(attemptId);
    const abort = () => {
      void this.runtime().cancel(input.name, attemptId).catch(() => undefined);
    };
    // A cancel that arrived while the start was in flight stops the attempt it started.
    if (input.signal.aborted) abort();
    else input.signal.addEventListener('abort', abort, { once: true });
    const phaseTimer = input.onPhase || input.onServices
      ? setInterval(() => void this.reportPhase(input.name, input.onPhase, input.onServices), 1_000)
      : undefined;
    try {
      for (;;) {
        if (input.signal.aborted) throw new ReplayEnvironmentError('CANCELED', 'Canceled');
        try {
          const result = await this.runtime().wait(input.name, attemptId, { timeoutMs: 30_000, signal: input.signal });
          if (result.state === 'ready') break;
          const failedService = Object.entries(result.services ?? {}).find(([, service]) => service.state === 'failed');
          const reason = result.error?.message ?? failedService?.[1].error?.message ?? 'The clean copy did not start.';
          if (/authoriz|approv|denied/i.test(reason)) throw new ReplayEnvironmentError('AUTHORIZATION', 'Clean runs are not allowed for this app right now.');
          throw new ReplayEnvironmentError('START_FAILED', reason, failedService?.[0]);
        } catch (error) {
          if (error instanceof PreviewError && error.code === 'TIMEOUT' && !input.signal.aborted) continue;
          if (input.signal.aborted) throw new ReplayEnvironmentError('CANCELED', 'Canceled');
          throw error;
        }
      }
    } finally {
      if (phaseTimer) clearInterval(phaseTimer);
      input.signal.removeEventListener('abort', abort);
      this.authorization.cancelStart(input.name);
    }
    const ready = await this.runtime().get(input.name);
    const attempt = ready.active?.id === attemptId ? ready.active : undefined;
    if (!attempt || attempt.state !== 'ready' || !ready.url) {
      throw new ReplayEnvironmentError('START_FAILED', 'The clean copy stopped before it was ready.');
    }
    const jobs = Object.entries(attempt.services ?? {})
      .filter(([, service]) => service.type === 'job')
      .map(([id, service]) => ({ id, state: service.state }));
    const skipped = jobs.find((job) => job.state === 'skipped');
    if (skipped) throw new ReplayEnvironmentError('NOT_CLEAN', `The clean copy skipped the ${skipped.id} job, so it could hold earlier data.`);
    const failedJob = jobs.find((job) => job.state !== 'succeeded');
    if (failedJob) throw new ReplayEnvironmentError('START_FAILED', `The ${failedJob.id} job did not succeed.`, failedJob.id);
    const origins: Record<string, string> = { primary: new URL(ready.url).origin };
    for (const [id, service] of Object.entries(attempt.services ?? {})) {
      if (service.browserUrl) origins[`s-${id}`] = new URL(service.browserUrl).origin;
    }
    return { attemptId, origins, readyAt: attempt.readyAt ?? new Date().toISOString(), jobs };
  }

  private async reportPhase(
    name: string,
    onPhase: ((phase: string) => void) | undefined,
    onServices: ((services: Array<{ id: string; type: string; state: string }>) => void) | undefined
  ): Promise<void> {
    try {
      const status = await this.runtime().get(name);
      const attempt = status.candidate ?? status.active;
      const services = Object.entries(attempt?.services ?? {});
      onServices?.(services.map(([id, service]) => ({ id, type: service.type, state: service.state })));
      const running = services.find(([, service]) => service.state === 'starting');
      if (!running || !onPhase) return;
      const [id, service] = running;
      if (service.type === 'job') onPhase(/install/i.test(id) ? 'Installing dependencies' : `Running ${id}`);
      else if (service.type === 'postgres' || service.type === 'redis') onPhase(`Starting ${id}`);
      else onPhase(`Waiting for ${id} to answer`);
    } catch {
      // Phase reports are best effort.
    }
  }

  /**
   * Warms dev servers that compile routes on first use, so a cold compile is not mistaken for a
   * hang: GET the pages and read APIs the recording used, and OPTIONS the routes it wrote to.
   */
  async warmUp(origins: Record<string, string>, requests: Array<{ role: string; method: 'GET' | 'OPTIONS'; path: string }>, signal: AbortSignal): Promise<string[]> {
    const facts: string[] = [];
    const deadline = Date.now() + 120_000;
    for (const request of requests.slice(0, 24)) {
      const origin = origins[request.role];
      if (!origin) continue;
      let attempts = 0;
      for (;;) {
        if (signal.aborted || Date.now() > deadline) return facts;
        attempts += 1;
        const outcome = await probe(`${origin}${request.path}`, request.method, signal);
        if (outcome === 'answered') break;
        if (attempts >= 20) {
          facts.push(`${request.method} ${request.path} was still compiling after warm-up`);
          break;
        }
        await sleep(Math.min(5_000, 500 * attempts));
      }
      if (attempts > 1) facts.push(`${request.path} needed ${attempts} warm-up requests`);
    }
    return facts;
  }

  /** The environment still serves the same attempt with every service ready, or the service that stopped. */
  async bracket(name: string, attemptId: string): Promise<{ ok: true } | { ok: false; service: string }> {
    try {
      const status = await this.runtime().get(name);
      if (status.active?.id !== attemptId || status.active.state !== 'ready') return { ok: false, service: 'the app' };
      const stopped = Object.entries(status.active.services ?? {}).find(
        ([, service]) => !['ready', 'succeeded'].includes(service.state)
      );
      return stopped ? { ok: false, service: stopped[0] } : { ok: true };
    } catch {
      return { ok: false, service: 'the app' };
    }
  }

  /** Reads new log text since `cursor`, bounded; logs are diagnostics only and never read by a verdict. */
  async logs(name: string, attemptId: string, cursor: number): Promise<{ text: string; cursor: number; truncated: boolean } | undefined> {
    try {
      const result = await this.runtime().logs(name, attemptId, { after: cursor, maxBytes: 64 * 1024 });
      return { text: result.text, cursor: result.cursor, truncated: result.truncated };
    } catch {
      return undefined;
    }
  }

  /**
   * Stops the name, deletes its managed data and forgets it. Returns the reason cleanup could not
   * finish, so the run can record cleanup debt and retry later.
   */
  async teardown(name: string): Promise<{ complete: true } | { complete: false; reason: string }> {
    if (!REPLAY_NAME_PATTERN.test(name)) throw new Error('Only br- names are torn down here.');
    this.authorization.own(name);
    const runtime = this.runtime();
    try {
      let status: PreviewStatus;
      try {
        status = await runtime.get(name);
      } catch (error) {
        if (error instanceof PreviewError && error.code === 'NOT_FOUND') {
          this.authorization.disown(name);
          return { complete: true };
        }
        throw error;
      }
      if (status.candidate) await runtime.cancel(name, status.candidate.id).catch(() => undefined);
      if (status.active || status.candidate || status.cleanup?.length || status.busy) {
        status = await runtime.stop(name, {
          expected: { active: status.active?.id ?? null, candidate: null, latest: status.latest?.id ?? null }
        }).catch(async () => runtime.stop(name));
      }
      if (status.data) {
        if ((await runtime.keystore.status()).state !== 'unlocked') {
          return { complete: false, reason: 'Unlock secrets to delete the clean copy’s data.' };
        }
        status = await runtime.deleteData(name, {
          expected: { attemptId: status.latest?.id ?? null, resources: status.data.resources }
        });
      }
      await runtime.remove(name, status.latest?.id ?? null);
      this.authorization.disown(name);
      return { complete: true };
    } catch (error) {
      return { complete: false, reason: errorMessage(error) };
    }
  }

  /** Every `br-` name the runtime knows, for startup cleanup of names a crash left behind. */
  async replayNames(): Promise<string[]> {
    return (await this.runtime().list()).map((status) => status.name).filter((name) => REPLAY_NAME_PATTERN.test(name));
  }
}

async function probe(url: string, method: 'GET' | 'OPTIONS', signal: AbortSignal): Promise<'answered' | 'gateway' | 'timeout'> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { method, redirect: 'manual', signal: controller.signal });
    const body = [400, 421, 502, 503, 508].includes(response.status) ? await response.text().catch(() => '') : '';
    if (isGatewaySignature(response.status, response.headers.get('content-type') ?? undefined, response.headers.get('cache-control') ?? undefined, body)) {
      return 'gateway';
    }
    await response.body?.cancel().catch(() => undefined);
    return 'answered';
  } catch {
    return 'timeout';
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
