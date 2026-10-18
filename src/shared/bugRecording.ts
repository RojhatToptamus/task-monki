import {
  BUG_CASE_KEYS,
  BUG_CASE_TEST_ID_ATTRIBUTES,
  type BugCaseEnvironment,
  type BugCaseTestIdAttribute
} from './bugCase';

/**
 * `bug-recording/v1`: what the recorder observed in a clean recording environment. The recorder
 * emits only this format and the case compiler accepts only this format. Every string in it was
 * read from the page under test and is untrusted data.
 */

export const BUG_RECORDING_SCHEMA = 'bug-recording/v1' as const;

export const BUG_RECORDING_LIMITS = {
  actions: 2000,
  requests: 4000,
  console: 200,
  textChars: 512,
  valueChars: 4096,
  cssChars: 2048,
  consoleChars: 2048,
  bodyBytes: 64 * 1024,
  picks: 5
} as const;

export interface BugRecordingTargetFacts {
  tag: string;
  inputType?: string;
  testIds: Array<{ attribute: BugCaseTestIdAttribute; value: string }>;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  /** Visible text, whitespace-normalised. */
  text?: string;
  /** Words that label the element on the page, such as "Cart total" before a value it shows. Display only. */
  context?: string;
  /** Always present: a structural CSS path from the document root. */
  css: string;
}

export interface BugRecordingLocation {
  role: string;
  path: string;
  query: Array<[string, string]>;
}

export type BugRecordingActionKind =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'press'
  | 'dialog'
  | 'reload'
  | 'unsupported';

export interface BugRecordingAction {
  index: number;
  /** Milliseconds since the recorder's start. */
  t: number;
  kind: BugRecordingActionKind;
  target?: BugRecordingTargetFacts;
  /** The final value of a field; absent when the field was a password. */
  value?: string;
  sensitive?: boolean;
  values?: string[];
  key?: string;
  dialog?: { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; action: 'accept' | 'dismiss'; promptText?: string };
  location?: BugRecordingLocation;
  /** What could not be replayed, e.g. "file chooser" or "⌘K". */
  unsupported?: string;
}

export type BugRecordingRequestOutcome = 'response' | 'failed' | 'blocked' | 'pending';

export interface BugRecordingRequest {
  id: string;
  t: number;
  method: string;
  /** The origin role; absent for an undeclared origin, which the recording browser refused. */
  role?: string;
  /** Host only, for undeclared origins. */
  host?: string;
  path: string;
  queryKeys: string[];
  resourceType: string;
  outcome: BugRecordingRequestOutcome;
  status?: number;
  /** The response matched Previewhost's own gateway error signature: the app did not answer. */
  gateway?: boolean;
  fromServiceWorker: boolean;
  mimeType?: string;
  durationMs?: number;
  /** The last action before the request started. */
  actionIndex?: number;
  /** Parsed JSON bodies, present only for requests in the marked window. */
  requestJson?: unknown;
  responseJson?: unknown;
}

export interface BugRecordingConsoleEntry {
  t: number;
  level: 'error' | 'warning' | 'exception';
  text: string;
}

export interface BugRecordingPick {
  target: BugRecordingTargetFacts;
  /** Visible text of the picked element, whitespace-normalised. */
  text: string;
  value?: string;
  visible: boolean;
  /** How many elements matched the picked element's own selector shapes when it was picked. */
  count: number;
}

export interface BugRecordingMark {
  t: number;
  /** The index of the marked action: the last action before Mark. */
  actionIndex: number;
  window: { startT: number; endT: number };
  location: BugRecordingLocation;
  picks: BugRecordingPick[];
}

export interface BugRecordingCoverage {
  complete: boolean;
  reasons: string[];
  blockedHosts: Array<{ host: string; count: number }>;
}

export interface BugRecordingLogV1 {
  schema: typeof BUG_RECORDING_SCHEMA;
  environment: BugCaseEnvironment;
  /** Roles that existed in the recording environment, 'primary' first. */
  roles: string[];
  actions: BugRecordingAction[];
  requests: BugRecordingRequest[];
  console: BugRecordingConsoleEntry[];
  coverage: BugRecordingCoverage;
  mark?: BugRecordingMark;
}

export class BugRecordingFormatError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BugRecordingFormatError';
  }
}

/** Strictly parses a sealed recording log; anything outside the format is refused. */
export function parseBugRecordingLog(value: unknown): BugRecordingLogV1 {
  const record = asRecord(value, 'The recording');
  keys(record, ['schema', 'environment', 'roles', 'actions', 'requests', 'console', 'coverage', 'mark'], 'The recording');
  if (record.schema !== BUG_RECORDING_SCHEMA) throw new BugRecordingFormatError('The recording has an unsupported schema.');
  const environment = parseEnvironment(record.environment);
  const roles = list(record.roles, 'Roles', 1, 16).map((role) => roleText(role));
  if (roles[0] !== 'primary') throw new BugRecordingFormatError('The recording has no primary origin.');
  const actions = list(record.actions, 'Actions', 0, BUG_RECORDING_LIMITS.actions).map((item, index) =>
    parseAction(item, index)
  );
  const requests = list(record.requests, 'Requests', 0, BUG_RECORDING_LIMITS.requests).map(parseRequest);
  const consoleEntries = list(record.console, 'Console', 0, BUG_RECORDING_LIMITS.console).map((item) => {
    const entry = asRecord(item, 'A console entry');
    keys(entry, ['t', 'level', 'text'], 'A console entry');
    if (entry.level !== 'error' && entry.level !== 'warning' && entry.level !== 'exception') {
      throw new BugRecordingFormatError('A console entry has an unknown level.');
    }
    return { t: time(entry.t), level: entry.level, text: text(entry.text, BUG_RECORDING_LIMITS.consoleChars) } as BugRecordingConsoleEntry;
  });
  const coverage = parseCoverage(record.coverage);
  const log: BugRecordingLogV1 = { schema: BUG_RECORDING_SCHEMA, environment, roles, actions, requests, console: consoleEntries, coverage };
  if (record.mark !== undefined) log.mark = parseMark(record.mark, actions.length);
  return log;
}

function parseEnvironment(value: unknown): BugCaseEnvironment {
  const record = asRecord(value, 'The environment');
  keys(record, ['viewport', 'deviceScaleFactor', 'colorScheme', 'locale', 'timezoneId'], 'The environment');
  const viewport = asRecord(record.viewport, 'The viewport');
  keys(viewport, ['width', 'height'], 'The viewport');
  if (record.colorScheme !== 'light' && record.colorScheme !== 'dark') {
    throw new BugRecordingFormatError('The color scheme is not valid.');
  }
  return {
    viewport: { width: int(viewport.width, 320, 3840), height: int(viewport.height, 320, 2400) },
    deviceScaleFactor: num(record.deviceScaleFactor, 1, 3),
    colorScheme: record.colorScheme,
    locale: text(record.locale, 35),
    timezoneId: text(record.timezoneId, 64)
  };
}

function parseAction(value: unknown, index: number): BugRecordingAction {
  const record = asRecord(value, 'An action');
  keys(record, ['index', 't', 'kind', 'target', 'value', 'sensitive', 'values', 'key', 'dialog', 'location', 'unsupported'], 'An action');
  if (record.index !== index) throw new BugRecordingFormatError('Actions are out of order.');
  const kinds: BugRecordingActionKind[] = ['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'dialog', 'reload', 'unsupported'];
  if (!kinds.includes(record.kind as BugRecordingActionKind)) throw new BugRecordingFormatError('An action has an unknown kind.');
  const action: BugRecordingAction = { index, t: time(record.t), kind: record.kind as BugRecordingActionKind };
  if (record.target !== undefined) action.target = parseTarget(record.target);
  if (record.value !== undefined) action.value = text(record.value, BUG_RECORDING_LIMITS.valueChars);
  if (record.sensitive !== undefined) action.sensitive = bool(record.sensitive);
  if (record.values !== undefined) action.values = list(record.values, 'Values', 0, 32).map((item) => text(item, BUG_RECORDING_LIMITS.valueChars));
  if (record.key !== undefined) action.key = text(record.key, 32);
  if (record.dialog !== undefined) {
    const dialog = asRecord(record.dialog, 'A dialog');
    keys(dialog, ['type', 'action', 'promptText'], 'A dialog');
    if (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(dialog.type as string)) {
      throw new BugRecordingFormatError('A dialog has an unknown type.');
    }
    if (dialog.action !== 'accept' && dialog.action !== 'dismiss') throw new BugRecordingFormatError('A dialog answer is not valid.');
    action.dialog = {
      type: dialog.type as 'alert' | 'confirm' | 'prompt' | 'beforeunload',
      action: dialog.action,
      ...(dialog.promptText === undefined ? {} : { promptText: text(dialog.promptText, BUG_RECORDING_LIMITS.valueChars) })
    };
  }
  if (record.location !== undefined) action.location = parseLocation(record.location);
  if (record.unsupported !== undefined) action.unsupported = text(record.unsupported, 120);
  if (action.kind === 'press' && action.key !== undefined && !BUG_CASE_KEYS.includes(action.key as never)) {
    throw new BugRecordingFormatError('A key press outside the supported set must be recorded as unsupported.');
  }
  return action;
}

function parseLocation(value: unknown): BugRecordingLocation {
  const record = asRecord(value, 'A location');
  keys(record, ['role', 'path', 'query'], 'A location');
  const pathValue = text(record.path, 2048);
  if (!pathValue.startsWith('/')) throw new BugRecordingFormatError('A location path must start with a slash.');
  return {
    role: roleText(record.role),
    path: pathValue,
    query: list(record.query, 'A query', 0, 64).map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) throw new BugRecordingFormatError('A query entry must be a pair.');
      return [text(entry[0], 256), text(entry[1], BUG_RECORDING_LIMITS.valueChars)] as [string, string];
    })
  };
}

function parseRequest(value: unknown): BugRecordingRequest {
  const record = asRecord(value, 'A request');
  keys(record, [
    'id', 't', 'method', 'role', 'host', 'path', 'queryKeys', 'resourceType', 'outcome', 'status', 'gateway',
    'fromServiceWorker', 'mimeType', 'durationMs', 'actionIndex', 'requestJson', 'responseJson'
  ], 'A request');
  const outcomes: BugRecordingRequestOutcome[] = ['response', 'failed', 'blocked', 'pending'];
  if (!outcomes.includes(record.outcome as BugRecordingRequestOutcome)) throw new BugRecordingFormatError('A request has an unknown outcome.');
  const request: BugRecordingRequest = {
    id: text(record.id, 128),
    t: time(record.t),
    method: text(record.method, 16).toUpperCase(),
    path: text(record.path, 2048),
    queryKeys: list(record.queryKeys, 'Query keys', 0, 64).map((key) => text(key, 256)),
    resourceType: text(record.resourceType, 32),
    outcome: record.outcome as BugRecordingRequestOutcome,
    fromServiceWorker: bool(record.fromServiceWorker)
  };
  if (record.role !== undefined) request.role = roleText(record.role);
  if (record.host !== undefined) request.host = text(record.host, 255);
  if (record.status !== undefined) request.status = int(record.status, 0, 999);
  if (record.gateway !== undefined) request.gateway = bool(record.gateway);
  if (record.mimeType !== undefined) request.mimeType = text(record.mimeType, 128);
  if (record.durationMs !== undefined) request.durationMs = num(record.durationMs, 0, 24 * 3600 * 1000);
  if (record.actionIndex !== undefined) request.actionIndex = int(record.actionIndex, 0, BUG_RECORDING_LIMITS.actions);
  if (record.requestJson !== undefined) request.requestJson = boundedJson(record.requestJson);
  if (record.responseJson !== undefined) request.responseJson = boundedJson(record.responseJson);
  return request;
}

function parseCoverage(value: unknown): BugRecordingCoverage {
  const record = asRecord(value, 'Coverage');
  keys(record, ['complete', 'reasons', 'blockedHosts'], 'Coverage');
  return {
    complete: bool(record.complete),
    reasons: list(record.reasons, 'Reasons', 0, 32).map((reason) => text(reason, 240)),
    blockedHosts: list(record.blockedHosts, 'Blocked hosts', 0, 64).map((item) => {
      const host = asRecord(item, 'A blocked host');
      keys(host, ['host', 'count'], 'A blocked host');
      return { host: text(host.host, 255), count: int(host.count, 1, 1_000_000) };
    })
  };
}

function parseMark(value: unknown, actionCount: number): BugRecordingMark {
  const record = asRecord(value, 'The mark');
  keys(record, ['t', 'actionIndex', 'window', 'location', 'picks'], 'The mark');
  const window = asRecord(record.window, 'The marked window');
  keys(window, ['startT', 'endT'], 'The marked window');
  const actionIndex = int(record.actionIndex, 0, Math.max(0, actionCount - 1));
  return {
    t: time(record.t),
    actionIndex,
    window: { startT: time(window.startT), endT: time(window.endT) },
    location: parseLocation(record.location),
    picks: list(record.picks, 'Picks', 0, BUG_RECORDING_LIMITS.picks).map((item) => {
      const pick = asRecord(item, 'A pick');
      keys(pick, ['target', 'text', 'value', 'visible', 'count'], 'A pick');
      return {
        target: parseTarget(pick.target),
        text: text(pick.text, BUG_RECORDING_LIMITS.valueChars),
        ...(pick.value === undefined ? {} : { value: text(pick.value, BUG_RECORDING_LIMITS.valueChars) }),
        visible: bool(pick.visible),
        count: int(pick.count, 0, 10_000)
      };
    })
  };
}

export function parseBugRecordingTarget(value: unknown): BugRecordingTargetFacts {
  return parseTarget(value);
}

function parseTarget(value: unknown): BugRecordingTargetFacts {
  const record = asRecord(value, 'A target');
  keys(record, ['tag', 'inputType', 'testIds', 'role', 'name', 'label', 'placeholder', 'text', 'context', 'css'], 'A target');
  const target: BugRecordingTargetFacts = {
    tag: text(record.tag, 64).toLowerCase(),
    testIds: list(record.testIds, 'Test ids', 0, 3).map((item) => {
      const testId = asRecord(item, 'A test id');
      keys(testId, ['attribute', 'value'], 'A test id');
      if (!BUG_CASE_TEST_ID_ATTRIBUTES.includes(testId.attribute as BugCaseTestIdAttribute)) {
        throw new BugRecordingFormatError('A test id names an unsupported attribute.');
      }
      return { attribute: testId.attribute as BugCaseTestIdAttribute, value: text(testId.value, BUG_RECORDING_LIMITS.textChars) };
    }),
    css: text(record.css, BUG_RECORDING_LIMITS.cssChars)
  };
  if (!target.css) throw new BugRecordingFormatError('A target has no CSS path.');
  for (const key of ['inputType', 'role', 'name', 'label', 'placeholder', 'text', 'context'] as const) {
    if (record[key] !== undefined) target[key] = text(record[key], BUG_RECORDING_LIMITS.textChars);
  }
  return target;
}

function boundedJson(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > BUG_RECORDING_LIMITS.bodyBytes) {
    throw new BugRecordingFormatError('A request body is too large.');
  }
  return JSON.parse(encoded) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BugRecordingFormatError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!set.has(key)) throw new BugRecordingFormatError(`${label} holds an unsupported field.`);
  }
}

function list(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) throw new BugRecordingFormatError(`${label} must be a list.`);
  if (value.length < min || value.length > max) throw new BugRecordingFormatError(`${label} has an unsupported length.`);
  return value;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new BugRecordingFormatError('A text field is not text.');
  if (value.length > max) throw new BugRecordingFormatError('A text field is too long.');
  return value;
}

function roleText(value: unknown): string {
  const role = text(value, 64);
  if (!/^[a-z][a-z0-9_-]*$/.test(role)) throw new BugRecordingFormatError('An origin role is not valid.');
  return role;
}

function int(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BugRecordingFormatError('A number is out of range.');
  }
  return value;
}

function num(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BugRecordingFormatError('A number is out of range.');
  }
  return value;
}

function time(value: unknown): number {
  return num(value, 0, 24 * 3600 * 1000);
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new BugRecordingFormatError('A flag must be true or false.');
  return value;
}
