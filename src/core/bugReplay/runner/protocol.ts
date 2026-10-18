import type { BugCaseV1 } from '../../../shared/bugCase';

/**
 * The contract between Task Monki core and its replay runner process. Core writes one plan per
 * run; the runner reports observations as NUL-free NDJSON frames on stdout and never decides a
 * verdict. Core validates every frame, so a truncated or forged stream is never a pass.
 */

export const BUG_REPLAY_PLAN_SCHEMA = 'bug-replay-plan/v1' as const;

export interface BugReplayRunTimeouts {
  /** One budget per targeted step, shared by all of its candidates. */
  stepMs: number;
  navigationMs: number;
  /** No request in flight for this long counts as network quiet. */
  quietMs: number;
  /** The quiet wait and the observation window never run past this cap. */
  quietCapMs: number;
  /** Assertions must hold continuously for this long after quiet. */
  windowMs: number;
  /** A request without response headers after this long is a hang. */
  hangMs: number;
  /** The whole run. */
  runMs: number;
}

export const DEFAULT_BUG_REPLAY_TIMEOUTS: BugReplayRunTimeouts = {
  stepMs: 10_000,
  navigationMs: 30_000,
  quietMs: 500,
  quietCapMs: 10_000,
  windowMs: 3_000,
  hangMs: 8_000,
  runMs: 180_000
};

export interface BugReplayRunPlan {
  schema: typeof BUG_REPLAY_PLAN_SCHEMA;
  runId: string;
  document: BugCaseV1;
  /** Origin role → the run's own origin, e.g. `http://127.0.0.1:52011`. */
  origins: Record<string, string>;
  browser: { executablePath: string; userDataDir: string };
  outDir: string;
  timeouts: BugReplayRunTimeouts;
  maxScreenshots: number;
  /** JSON pointers the case reads, per side, so the runner keeps only those values. */
  pointers: { request: string[]; response: string[] };
}

export type BugReplayStepFailureCode =
  | 'not-found'
  | 'ambiguous'
  | 'not-actionable'
  | 'navigation-failed'
  | 'unexpected-dialog'
  | 'dialog-missing'
  | 'page-crashed';

export interface BugReplayDomObservation {
  kind: 'dom';
  /** A candidate resolved to exactly one visible element (or, for counts, to at least one). */
  found: boolean;
  candidateIndex?: number;
  /** Elements the resolved candidate matched; for absence checks, the most any candidate matched. */
  count: number;
  text?: string;
  value?: string;
  visible: boolean;
  /** The expected condition held at the end of the window. */
  matched: boolean;
  /** The condition held continuously from its first match to the end of the window. */
  held: boolean;
  firstMatchAtMs?: number;
  /** Text or value when the condition first held, when it later changed. */
  firstMatchText?: string;
}

export interface BugReplayRequestFact {
  method: string;
  role?: string;
  host?: string;
  path: string;
  queryKeys: string[];
  resourceType: string;
  fromServiceWorker: boolean;
  outcome: 'response' | 'failed' | 'blocked' | 'pending';
  status?: number;
  /** The response carried Previewhost's own gateway error signature. */
  gateway?: boolean;
  pendingMs?: number;
  /** Canonical JSON at each requested pointer; null when the pointer was absent. */
  requestValues?: Record<string, string | null>;
  responseValues?: Record<string, string | null>;
  startedAtMs: number;
}

export interface BugReplayRequestObservation {
  kind: 'request';
  matches: BugReplayRequestFact[];
}

export interface BugReplayPathObservation {
  kind: 'path';
  path: string;
}

export interface BugReplayConsoleObservation {
  kind: 'console';
  errors: string[];
}

export type BugReplayObservation =
  | BugReplayDomObservation
  | BugReplayRequestObservation
  | BugReplayPathObservation
  | BugReplayConsoleObservation;

export type BugReplaySignalKind =
  | 'renderer-crash'
  | 'hang'
  | 'gateway-response'
  | 'page-error'
  | 'page-navigation'
  | 'network-never-quiet'
  | 'retried-navigation'
  | 'unexpected-dialog';

export type BugReplayFrame =
  | { type: 'run-started'; planSha256: string; browserVersion: string }
  | {
      type: 'step';
      stepId: string;
      index: number;
      status: 'done' | 'failed';
      candidateIndex?: number;
      failure?: BugReplayStepFailureCode;
      detail?: string;
      atMs: number;
    }
  | { type: 'window'; phase: 'main' | 'afterReload'; startedAtMs: number; endedAtMs: number; quiet: boolean }
  | {
      type: 'assertion';
      assertionId: string;
      phase: 'main' | 'afterReload';
      observation: BugReplayObservation;
    }
  | { type: 'requests'; phase: 'main'; requests: BugReplayRequestFact[] }
  | { type: 'signal'; signal: BugReplaySignalKind; detail: string; atMs: number }
  | {
      type: 'screenshot';
      name: string;
      sha256: string;
      bytes: number;
      purpose: 'failure' | 'final';
      /** On the final screenshot: where each found element a check read sat in it, in viewport CSS pixels. */
      marks?: BugReplayElementMark[];
    }
  | { type: 'run-finished'; steps: number; assertions: number; frames: number }
  | { type: 'fatal'; detail: string };

export interface BugReplayElementMark {
  assertionId: string;
  box: { x: number; y: number; width: number; height: number };
}

export type BugReplayFrameEnvelope = BugReplayFrame & { nonce: string; seq: number };

/** Previewhost 0.5.x gateway error bodies; an app response with one of these is the gateway's, not the app's. */
export const PREVIEWHOST_GATEWAY_MESSAGES: ReadonlyArray<{ status: number; message: string }> = [
  { status: 421, message: 'Unknown preview Host.' },
  { status: 400, message: 'Use an origin-relative request path.' },
  { status: 400, message: 'Invalid proxy hop header.' },
  { status: 508, message: 'Preview proxy loop detected.' },
  { status: 503, message: 'The preview is not ready.' },
  { status: 503, message: 'The preview is at its request limit.' },
  { status: 502, message: 'The preview target is unavailable.' }
];

export function isGatewaySignature(status: number, contentType: string | undefined, cacheControl: string | undefined, body: string): boolean {
  if (contentType !== 'text/plain; charset=utf-8' || cacheControl !== 'no-store') return false;
  return PREVIEWHOST_GATEWAY_MESSAGES.some((entry) => entry.status === status && body === `${entry.message}\n`);
}

export const MAX_RUNNER_FRAME_BYTES = 256 * 1024;
export const MAX_RUNNER_FRAMES = 2_000;
