import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDomAssertion, type BugCaseV1 } from '../../shared/bugCase';
import { ProcessSupervisor, redactProcessDiagnostic } from '../process/ProcessSupervisor';
import {
  BUG_REPLAY_PLAN_SCHEMA,
  DEFAULT_BUG_REPLAY_TIMEOUTS,
  MAX_RUNNER_FRAMES,
  MAX_RUNNER_FRAME_BYTES,
  type BugReplayFrame,
  type BugReplayFrameEnvelope,
  type BugReplayRunPlan,
  type BugReplayRunTimeouts
} from './runner/protocol';

/** Where the runner, its JavaScript runtime, playwright-core and the browser live in this build. */
export interface BugReplayRunnerPaths {
  /** Task Monki's own Node: `process.execPath`, run with ELECTRON_RUN_AS_NODE under Electron. */
  nodeExecutable: string;
  runnerScript: string;
  playwrightPackage: string;
  browserExecutable: string;
}

export interface BugReplayRunnerRequest {
  runId: string;
  document: BugCaseV1;
  origins: Record<string, string>;
  /** A marker-owned private directory this run may use; it is not cleaned here. */
  scratchDir: string;
  signal: AbortSignal;
  timeouts?: Partial<BugReplayRunTimeouts>;
  maxScreenshots?: number;
}

export interface BugReplayRunnerScreenshot {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  purpose: 'failure' | 'final';
}

export type BugReplayRunnerResult =
  | { kind: 'completed'; frames: BugReplayFrame[]; screenshots: BugReplayRunnerScreenshot[]; browserVersion: string }
  | { kind: 'invalid'; detail: string; diagnostics: string }
  | { kind: 'canceled' };

/**
 * Runs one case through Task Monki's runner process. A run counts only when the frame stream is
 * complete and consistent: the plan hash echoed, the nonce on every frame, contiguous sequence
 * numbers, one frame per step and check, and matching final counts. Anything else is an
 * infrastructure failure, never a pass.
 */
export class BugReplayRunner {
  constructor(
    private readonly paths: () => BugReplayRunnerPaths | undefined,
    private readonly supervisor = new ProcessSupervisor()
  ) {}

  available(): boolean {
    return Boolean(this.paths());
  }

  async run(request: BugReplayRunnerRequest): Promise<BugReplayRunnerResult> {
    const paths = this.paths();
    if (!paths) return { kind: 'invalid', detail: 'The replay browser is not available in this build.', diagnostics: '' };
    const control = path.join(request.scratchDir, 'control');
    const outDir = path.join(request.scratchDir, 'out');
    const profile = path.join(request.scratchDir, 'profile');
    for (const directory of [control, outDir, profile]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const timeouts = { ...DEFAULT_BUG_REPLAY_TIMEOUTS, ...request.timeouts };
    const plan: BugReplayRunPlan = {
      schema: BUG_REPLAY_PLAN_SCHEMA,
      runId: request.runId,
      document: request.document,
      origins: request.origins,
      browser: { executablePath: paths.browserExecutable, userDataDir: profile },
      outDir,
      timeouts,
      maxScreenshots: request.maxScreenshots ?? 6,
      pointers: pointersOf(request.document)
    };
    const planPath = path.join(control, 'plan.json');
    const planBytes = Buffer.from(JSON.stringify(plan), 'utf8');
    await fs.writeFile(planPath, planBytes, { mode: 0o600, flag: 'wx' });
    const planSha256 = createHash('sha256').update(planBytes).digest('hex');
    const nonce = randomBytes(16).toString('hex');
    if (request.signal.aborted) return { kind: 'canceled' };

    const child = this.supervisor.start({
      executable: paths.nodeExecutable,
      argv: [paths.runnerScript, planPath, planSha256, nonce, paths.playwrightPackage],
      cwd: request.scratchDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TMPDIR: request.scratchDir },
      allowedEnvironmentKeys: ['ELECTRON_RUN_AS_NODE']
    });
    const frames: BugReplayFrameEnvelope[] = [];
    let buffered = '';
    let stderr = '';
    let violation: string | undefined;
    const note = (reason: string) => {
      violation ??= reason;
    };
    child.events.on('stdout', (chunk) => {
      buffered += chunk.toString('utf8');
      if (buffered.length > MAX_RUNNER_FRAME_BYTES * 4) {
        note('The replay runner wrote more than it may.');
        buffered = '';
        void child.cancel().catch(() => undefined);
        return;
      }
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        if (line.length > MAX_RUNNER_FRAME_BYTES || frames.length >= MAX_RUNNER_FRAMES) {
          note('The replay runner wrote an oversized report.');
          continue;
        }
        try {
          frames.push(JSON.parse(line) as BugReplayFrameEnvelope);
        } catch {
          note('The replay runner wrote something that is not a report.');
        }
      }
    });
    child.events.on('stderr', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024);
    });
    const finished = new Promise<{ exitCode: number | null; error?: string }>((resolve) => {
      child.events.once('close', (terminal) => resolve({ exitCode: terminal.exitCode }));
      child.events.once('terminationUnconfirmed', (event) => resolve({ exitCode: event.leaderExit.exitCode, error: event.error.message }));
      child.events.once('error', (error) => resolve({ exitCode: null, error: error.message }));
    });
    let canceled = false;
    const cancel = () => {
      canceled = true;
      void child.cancel().catch(() => undefined);
    };
    request.signal.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(() => {
      note('The replay runner took longer than its limit.');
      void child.cancel().catch(() => undefined);
    }, timeouts.runMs + 20_000);
    const terminal = await finished;
    clearTimeout(deadline);
    request.signal.removeEventListener('abort', cancel);
    const diagnostics = redactProcessDiagnostic(stderr, request.document.sensitiveInputs.map((input) => input.value));
    if (canceled) return { kind: 'canceled' };
    if (terminal.error && !violation) note(`The replay runner did not exit cleanly (${terminal.error.slice(0, 160)}).`);
    const validated = validateFrames(frames, { nonce, planSha256, document: request.document });
    if (violation) return { kind: 'invalid', detail: violation, diagnostics };
    if (validated.kind === 'invalid') return { ...validated, diagnostics };
    if (terminal.exitCode !== 0) return { kind: 'invalid', detail: 'The replay runner stopped.', diagnostics };
    const screenshots: BugReplayRunnerScreenshot[] = [];
    for (const frame of validated.frames) {
      if (frame.type !== 'screenshot') continue;
      if (!/^(?:failure|final)-\d+\.png$/.test(frame.name)) return { kind: 'invalid', detail: 'The replay runner named a screenshot it may not write.', diagnostics };
      const file = path.join(outDir, frame.name);
      const bytes = await fs.readFile(file).catch(() => undefined);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== frame.sha256 || bytes.length !== frame.bytes) {
        return { kind: 'invalid', detail: 'A screenshot did not match the runner report.', diagnostics };
      }
      screenshots.push({ name: frame.name, path: file, sha256: frame.sha256, bytes: frame.bytes, purpose: frame.purpose });
    }
    return { kind: 'completed', frames: validated.frames, screenshots, browserVersion: validated.browserVersion };
  }
}

/** JSON pointers the case reads, per side, so the runner keeps only those values. */
export function pointersOf(document: BugCaseV1): { request: string[]; response: string[] } {
  const request = new Set<string>();
  const response = new Set<string>();
  for (const assertion of document.assertions) {
    if (assertion.kind !== 'request.json') continue;
    (assertion.side === 'request' ? request : response).add(assertion.pointer);
  }
  return { request: [...request].slice(0, 8), response: [...response].slice(0, 8) };
}

type Validation =
  | { kind: 'valid'; frames: BugReplayFrame[]; browserVersion: string }
  | { kind: 'invalid'; detail: string };

/** Every rule a frame stream must meet before core reads a single observation from it. */
export function validateFrames(
  envelopes: BugReplayFrameEnvelope[],
  expected: { nonce: string; planSha256: string; document: BugCaseV1 }
): Validation {
  const invalid = (detail: string): Validation => ({ kind: 'invalid', detail });
  if (envelopes.length === 0) return invalid('The replay runner stopped before it reported anything.');
  for (const [index, envelope] of envelopes.entries()) {
    if (!envelope || typeof envelope !== 'object' || envelope.nonce !== expected.nonce || envelope.seq !== index) {
      return invalid('The replay report is not from this run.');
    }
  }
  const frames = envelopes.map(({ nonce: _nonce, seq: _seq, ...frame }) => frame as BugReplayFrame);
  const fatal = frames.find((frame) => frame.type === 'fatal');
  if (fatal && fatal.type === 'fatal') return invalid(`The replay runner stopped: ${fatal.detail.slice(0, 200)}`);
  const started = frames[0];
  if (started.type !== 'run-started' || started.planSha256 !== expected.planSha256) {
    return invalid('The replay runner did not confirm its plan.');
  }
  const finished = frames[frames.length - 1];
  if (finished.type !== 'run-finished') return invalid('The replay runner stopped before it finished.');
  const steps = frames.filter((frame): frame is Extract<BugReplayFrame, { type: 'step' }> => frame.type === 'step');
  const assertions = frames.filter((frame): frame is Extract<BugReplayFrame, { type: 'assertion' }> => frame.type === 'assertion');
  if (finished.steps !== steps.length || finished.assertions !== assertions.length || finished.frames !== frames.length) {
    return invalid('The replay report counts do not match.');
  }
  const document = expected.document;
  for (const [index, step] of steps.entries()) {
    if (step.index !== index || document.steps[index]?.id !== step.stepId) return invalid('The replay report skipped a step.');
  }
  const failed = steps.findIndex((step) => step.status === 'failed');
  if (failed >= 0 && failed !== steps.length - 1) return invalid('The replay runner continued after a failed step.');
  if (failed < 0) {
    if (steps.length !== document.steps.length) return invalid('The replay report skipped a step.');
    const main = new Set<string>();
    const afterReload = new Set<string>();
    for (const assertion of assertions) {
      const set = assertion.phase === 'main' ? main : afterReload;
      if (set.has(assertion.assertionId)) return invalid('The replay report repeated a check.');
      set.add(assertion.assertionId);
    }
    for (const assertion of document.assertions) {
      if (!main.has(assertion.id)) return invalid('The replay report skipped a check.');
    }
    const reloadIds = document.assertions.filter((assertion) => isDomAssertion(assertion) && assertion.alsoAfterReload).map((assertion) => assertion.id);
    const crashed = frames.some((frame) => frame.type === 'signal' && frame.signal === 'renderer-crash');
    if (!crashed) {
      for (const id of reloadIds) if (!afterReload.has(id)) return invalid('The replay report skipped a check after reload.');
    }
    if (main.size !== document.assertions.length || [...afterReload].some((id) => !reloadIds.includes(id))) {
      return invalid('The replay report holds a check the case does not have.');
    }
  } else if (assertions.length > 0) {
    return invalid('The replay report holds checks after a failed step.');
  }
  return { kind: 'valid', frames, browserVersion: started.browserVersion };
}
