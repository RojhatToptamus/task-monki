import {
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
  /** Where it sat in the screenshot taken when the bug was marked, in CSS pixels of the viewport. */
  box?: { x: number; y: number; width: number; height: number };
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
