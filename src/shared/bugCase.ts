/**
 * `bug-case/v1`: the closed, strictly parsed oracle that Task Monki's own runner interprets.
 * A case holds steps, expectations and the failure the recording showed; it never holds code,
 * selectors that run script, regular expressions, waits or anything the app under test can
 * change. Only the person creates a version, through the UI.
 */

export const BUG_CASE_SCHEMA = 'bug-case/v1' as const;

export const BUG_CASE_LIMITS = {
  steps: 120,
  assertions: 20,
  domAssertions: 5,
  candidates: 8,
  valueChars: 4096,
  documentBytes: 48 * 1024,
  pathChars: 512,
  queryEntries: 32,
  sensitiveInputs: 20,
  selectValues: 32,
  jsonPointers: 8,
  origins: 16,
  idChars: 64
} as const;

export const BUG_CASE_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight'
] as const;

export type BugCaseKey = (typeof BUG_CASE_KEYS)[number];

export const BUG_CASE_TEST_ID_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy'] as const;

export type BugCaseTestIdAttribute = (typeof BUG_CASE_TEST_ID_ATTRIBUTES)[number];

export type BugCaseTargetCandidate =
  | { kind: 'testId'; attribute: BugCaseTestIdAttribute; value: string }
  | { kind: 'role'; role: string; name: string }
  | { kind: 'label'; value: string }
  | { kind: 'placeholder'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'css'; value: string };

/** Candidates in the order the runner tries them; the first that matches exactly one visible element wins. */
export interface BugCaseTarget {
  candidates: BugCaseTargetCandidate[];
  /** What people call it, from the page around it ("Notes"); never used to find the element. */
  label?: string;
}

export type BugCaseStep =
  | { id: string; kind: 'navigate'; origin: string; path: string; query: Array<[string, string]> }
  | { id: string; kind: 'reload' }
  | { id: string; kind: 'click'; target: BugCaseTarget; count?: 2 | 3; intervalMs?: number }
  | { id: string; kind: 'check' | 'uncheck'; target: BugCaseTarget }
  | { id: string; kind: 'fill'; target: BugCaseTarget; value?: string; sensitiveRef?: string }
  | { id: string; kind: 'select'; target: BugCaseTarget; values: string[] }
  | { id: string; kind: 'press'; key: BugCaseKey }
  | { id: string; kind: 'dialog'; action: 'accept' | 'dismiss'; promptText?: string };

export type BugCaseRequestStatus = 'success' | 'answered' | number;

export type BugCaseAssertion =
  | {
      id: string;
      kind: 'dom.text';
      target: BugCaseTarget;
      op: 'equals' | 'contains';
      value: string;
      alsoAfterReload: boolean;
    }
  | { id: string; kind: 'dom.value'; target: BugCaseTarget; value: string; alsoAfterReload: boolean }
  | { id: string; kind: 'dom.visible'; target: BugCaseTarget; expected: boolean; alsoAfterReload: boolean }
  | { id: string; kind: 'dom.count'; target: BugCaseTarget; value: number; alsoAfterReload: boolean }
  | { id: string; kind: 'page.path'; template: string }
  | {
      id: string;
      kind: 'request';
      method: string;
      origin: string;
      pathTemplate: string;
      queryKeys: string[];
      count: { op: 'atLeast' | 'exactly'; n: number };
      status?: BugCaseRequestStatus;
    }
  | {
      id: string;
      kind: 'request.json';
      requestId: string;
      side: 'request' | 'response';
      pointer: string;
      /** Canonical JSON text of the expected value. */
      equals: string;
    }
  | { id: string; kind: 'console.noUncaughtError' };

/** What the recording showed for a check it violated. */
export type BugCaseCaptured =
  | { kind: 'text'; token: string }
  | { kind: 'value'; value: string }
  | { kind: 'visible'; value: boolean }
  | { kind: 'count'; value: number }
  | { kind: 'path'; value: string }
  | { kind: 'status'; value: number | 'no-response' }
  | { kind: 'requestCount'; value: number }
  /** Canonical JSON of the observed value, or null when the pointer was absent. */
  | { kind: 'json'; value: string | null };

export interface BugCaseSignatureEntry {
  assertionId: string;
  /** CAPTURED: the run must show what the recording showed. ANY_MISMATCH: any failure of the check. */
  mode: 'CAPTURED' | 'ANY_MISMATCH';
  captured?: BugCaseCaptured;
}

export interface BugCaseEnvironment {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  colorScheme: 'light' | 'dark';
  locale: string;
  timezoneId: string;
}

export interface BugCaseV1 {
  schema: typeof BUG_CASE_SCHEMA;
  /** 'primary' or a service id. A run maps each role to its own origin; literal URLs are never stored. */
  origins: Array<{ role: string }>;
  environment: BugCaseEnvironment;
  /** The first step is the only navigate step: the clean start. */
  steps: BugCaseStep[];
  assertions: BugCaseAssertion[];
  failureSignature: BugCaseSignatureEntry[];
  /** Values typed into password fields; masked on every surface. */
  sensitiveInputs: Array<{ id: string; value: string }>;
  keepBrowserStorageAfterReload: boolean;
}

export type BugCaseAssertionKind = BugCaseAssertion['kind'];

export function isDomAssertion(
  assertion: BugCaseAssertion
): assertion is Extract<BugCaseAssertion, { kind: 'dom.text' | 'dom.value' | 'dom.visible' | 'dom.count' }> {
  return (
    assertion.kind === 'dom.text' ||
    assertion.kind === 'dom.value' ||
    assertion.kind === 'dom.visible' ||
    assertion.kind === 'dom.count'
  );
}

/** A request the marked action must send and the app must answer with the expected status. */
export function isRequiredPath(assertion: BugCaseAssertion): boolean {
  return (
    assertion.kind === 'request' &&
    assertion.count.op === 'atLeast' &&
    assertion.count.n >= 1 &&
    assertion.status !== undefined
  );
}

/** Absence checks hold when nothing is there; they can be satisfied by removing a feature. */
export function isAbsenceAssertion(assertion: BugCaseAssertion): boolean {
  return (
    (assertion.kind === 'dom.visible' && !assertion.expected) ||
    (assertion.kind === 'dom.count' && assertion.value === 0) ||
    (assertion.kind === 'request' && assertion.count.op === 'exactly' && assertion.count.n === 0) ||
    assertion.kind === 'console.noUncaughtError'
  );
}

export function isDuplicateEffectAssertion(assertion: BugCaseAssertion): boolean {
  return assertion.kind === 'request' && assertion.count.op === 'exactly' && assertion.count.n >= 1;
}

export function isPositiveAssertion(assertion: BugCaseAssertion): boolean {
  if (isAbsenceAssertion(assertion) || isDuplicateEffectAssertion(assertion)) return false;
  if (assertion.kind === 'request') return isRequiredPath(assertion);
  return true;
}

export class BugCaseValidationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BugCaseValidationError';
  }
}

/**
 * Strictly parses an untrusted value into a case document. Unknown keys, code-like fields,
 * oversized values and structural inconsistencies are refused with one reason.
 */
export function parseBugCase(value: unknown): BugCaseV1 {
  const record = requireRecord(value, 'The case');
  onlyKeys(record, [
    'schema',
    'origins',
    'environment',
    'steps',
    'assertions',
    'failureSignature',
    'sensitiveInputs',
    'keepBrowserStorageAfterReload'
  ], 'The case');
  if (record.schema !== BUG_CASE_SCHEMA) throw new BugCaseValidationError('The case has an unsupported schema.');
  const origins = requireArray(record.origins, 'Origins', 1, BUG_CASE_LIMITS.origins).map((item) => {
    const origin = requireRecord(item, 'An origin');
    onlyKeys(origin, ['role'], 'An origin');
    return { role: requireRole(origin.role) };
  });
  const roles = new Set(origins.map((origin) => origin.role));
  if (roles.size !== origins.length) throw new BugCaseValidationError('Origins repeat a role.');
  if (!roles.has('primary')) throw new BugCaseValidationError('The case has no primary origin.');
  const environment = parseEnvironment(record.environment);
  const sensitiveInputs = requireArray(record.sensitiveInputs, 'Sensitive inputs', 0, BUG_CASE_LIMITS.sensitiveInputs).map(
    (item) => {
      const input = requireRecord(item, 'A sensitive input');
      onlyKeys(input, ['id', 'value'], 'A sensitive input');
      return { id: requireId(input.id), value: requireText(input.value, 'A sensitive value', 1) };
    }
  );
  const sensitiveIds = new Set(sensitiveInputs.map((input) => input.id));
  const steps = requireArray(record.steps, 'Steps', 1, BUG_CASE_LIMITS.steps).map((item, index) =>
    parseStep(item, index, roles, sensitiveIds)
  );
  if (steps[0].kind !== 'navigate') throw new BugCaseValidationError('The first step must open the start page.');
  if (steps.slice(1).some((step) => step.kind === 'navigate')) {
    throw new BugCaseValidationError('Only the first step may open a page.');
  }
  if (steps[steps.length - 1].kind === 'dialog' && steps.length === 1) {
    throw new BugCaseValidationError('A dialog step needs an action before it.');
  }
  const assertions = requireArray(record.assertions, 'Checks', 1, BUG_CASE_LIMITS.assertions).map((item) =>
    parseAssertion(item, roles)
  );
  const failureSignature = requireArray(record.failureSignature, 'The failure signature', 1, BUG_CASE_LIMITS.assertions).map(
    parseSignatureEntry
  );
  if (typeof record.keepBrowserStorageAfterReload !== 'boolean') {
    throw new BugCaseValidationError('The browser storage option must be true or false.');
  }
  const document: BugCaseV1 = {
    schema: BUG_CASE_SCHEMA,
    origins,
    environment,
    steps,
    assertions,
    failureSignature,
    sensitiveInputs,
    keepBrowserStorageAfterReload: record.keepBrowserStorageAfterReload
  };
  validateBugCaseStructure(document);
  return document;
}

/** Cross-field rules every stored case satisfies. */
export function validateBugCaseStructure(document: BugCaseV1): void {
  const ids = new Set<string>();
  for (const item of [...document.steps, ...document.assertions]) {
    if (ids.has(item.id)) throw new BugCaseValidationError(`The id ${item.id} repeats.`);
    ids.add(item.id);
  }
  const assertionsById = new Map(document.assertions.map((assertion) => [assertion.id, assertion]));
  if (document.assertions.filter(isDomAssertion).length > BUG_CASE_LIMITS.domAssertions) {
    throw new BugCaseValidationError(`A case holds at most ${BUG_CASE_LIMITS.domAssertions} page checks.`);
  }
  for (const assertion of document.assertions) {
    if (assertion.kind !== 'request.json') continue;
    const anchor = assertionsById.get(assertion.requestId);
    if (!anchor || anchor.kind !== 'request') {
      throw new BugCaseValidationError('A value check must belong to a request check.');
    }
  }
  if (!document.assertions.some(isPositiveAssertion)) {
    throw new BugCaseValidationError('Add a check for what should happen, not only what should not.');
  }
  const signatureIds = new Set<string>();
  for (const entry of document.failureSignature) {
    if (signatureIds.has(entry.assertionId)) throw new BugCaseValidationError('The failure signature repeats a check.');
    signatureIds.add(entry.assertionId);
    const assertion = assertionsById.get(entry.assertionId);
    if (!assertion) throw new BugCaseValidationError('The failure signature names a missing check.');
    if (entry.mode === 'CAPTURED' && !entry.captured) {
      throw new BugCaseValidationError('A recorded failure needs what the recording showed.');
    }
    if (entry.captured && !capturedFits(assertion, entry.captured)) {
      throw new BugCaseValidationError('What the recording showed does not fit its check.');
    }
  }
  // A failure made only of absence checks could be "fixed" by removing the feature, so it
  // must sit beside a request the app has to keep answering.
  const signature = document.failureSignature.map((entry) => assertionsById.get(entry.assertionId)!);
  if (!signature.some(isPositiveAssertion) && !document.assertions.some(isRequiredPath)) {
    throw new BugCaseValidationError('A check that something is absent needs a check that something happens.');
  }
}

function capturedFits(assertion: BugCaseAssertion, captured: BugCaseCaptured): boolean {
  switch (assertion.kind) {
    case 'dom.text':
      return captured.kind === 'text';
    case 'dom.value':
      return captured.kind === 'value';
    case 'dom.visible':
      return captured.kind === 'visible';
    case 'dom.count':
      return captured.kind === 'count';
    case 'page.path':
      return captured.kind === 'path';
    case 'request':
      return captured.kind === 'status' || captured.kind === 'requestCount';
    case 'request.json':
      return captured.kind === 'json';
    case 'console.noUncaughtError':
      return false;
  }
}

function parseEnvironment(value: unknown): BugCaseEnvironment {
  const record = requireRecord(value, 'The page environment');
  onlyKeys(record, ['viewport', 'deviceScaleFactor', 'colorScheme', 'locale', 'timezoneId'], 'The page environment');
  const viewport = requireRecord(record.viewport, 'The viewport');
  onlyKeys(viewport, ['width', 'height'], 'The viewport');
  const width = requireInteger(viewport.width, 'The viewport width', 320, 3840);
  const height = requireInteger(viewport.height, 'The viewport height', 320, 2400);
  const deviceScaleFactor = requireNumber(record.deviceScaleFactor, 'The scale factor', 1, 3);
  if (record.colorScheme !== 'light' && record.colorScheme !== 'dark') {
    throw new BugCaseValidationError('The color scheme must be light or dark.');
  }
  const locale = requireText(record.locale, 'The locale', 2, 35);
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale)) throw new BugCaseValidationError('The locale is not valid.');
  const timezoneId = requireText(record.timezoneId, 'The time zone', 1, 64);
  if (!/^[A-Za-z0-9_+\-/]+$/.test(timezoneId)) throw new BugCaseValidationError('The time zone is not valid.');
  return { viewport: { width, height }, deviceScaleFactor, colorScheme: record.colorScheme, locale, timezoneId };
}

function parseStep(value: unknown, index: number, roles: Set<string>, sensitiveIds: Set<string>): BugCaseStep {
  const record = requireRecord(value, `Step ${index + 1}`);
  const id = requireId(record.id);
  switch (record.kind) {
    case 'navigate': {
      onlyKeys(record, ['id', 'kind', 'origin', 'path', 'query'], `Step ${index + 1}`);
      const origin = requireRole(record.origin);
      if (!roles.has(origin)) throw new BugCaseValidationError(`Step ${index + 1} opens an undeclared origin.`);
      return { id, kind: 'navigate', origin, path: requirePath(record.path), query: parseQuery(record.query) };
    }
    case 'reload':
      onlyKeys(record, ['id', 'kind'], `Step ${index + 1}`);
      return { id, kind: 'reload' };
    case 'click': {
      onlyKeys(record, ['id', 'kind', 'target', 'count', 'intervalMs'], `Step ${index + 1}`);
      const step: BugCaseStep = { id, kind: 'click', target: parseTarget(record.target) };
      if (record.count !== undefined) {
        if (record.count !== 2 && record.count !== 3) throw new BugCaseValidationError('A click repeats 2 or 3 times.');
        step.count = record.count;
        step.intervalMs = requireInteger(record.intervalMs, 'The click interval', 0, 500);
      } else if (record.intervalMs !== undefined) {
        throw new BugCaseValidationError('A single click has no interval.');
      }
      return step;
    }
    case 'check':
    case 'uncheck':
      onlyKeys(record, ['id', 'kind', 'target'], `Step ${index + 1}`);
      return { id, kind: record.kind, target: parseTarget(record.target) };
    case 'fill': {
      onlyKeys(record, ['id', 'kind', 'target', 'value', 'sensitiveRef'], `Step ${index + 1}`);
      const target = parseTarget(record.target);
      if ((record.value === undefined) === (record.sensitiveRef === undefined)) {
        throw new BugCaseValidationError(`Step ${index + 1} needs exactly one value.`);
      }
      if (record.sensitiveRef !== undefined) {
        const ref = requireId(record.sensitiveRef);
        if (!sensitiveIds.has(ref)) throw new BugCaseValidationError(`Step ${index + 1} names a missing sensitive value.`);
        return { id, kind: 'fill', target, sensitiveRef: ref };
      }
      return { id, kind: 'fill', target, value: requireText(record.value, 'A typed value', 0) };
    }
    case 'select': {
      onlyKeys(record, ['id', 'kind', 'target', 'values'], `Step ${index + 1}`);
      const values = requireArray(record.values, 'Selected values', 0, BUG_CASE_LIMITS.selectValues).map((item) =>
        requireText(item, 'A selected value', 0)
      );
      return { id, kind: 'select', target: parseTarget(record.target), values };
    }
    case 'press': {
      onlyKeys(record, ['id', 'kind', 'key'], `Step ${index + 1}`);
      if (!BUG_CASE_KEYS.includes(record.key as BugCaseKey)) {
        throw new BugCaseValidationError(`Step ${index + 1} presses an unsupported key.`);
      }
      return { id, kind: 'press', key: record.key as BugCaseKey };
    }
    case 'dialog': {
      onlyKeys(record, ['id', 'kind', 'action', 'promptText'], `Step ${index + 1}`);
      if (record.action !== 'accept' && record.action !== 'dismiss') {
        throw new BugCaseValidationError(`Step ${index + 1} answers a dialog with an unknown action.`);
      }
      const step: BugCaseStep = { id, kind: 'dialog', action: record.action };
      if (record.promptText !== undefined) step.promptText = requireText(record.promptText, 'Dialog text', 0);
      return step;
    }
    default:
      throw new BugCaseValidationError(`Step ${index + 1} has an unsupported kind.`);
  }
}

function parseAssertion(value: unknown, roles: Set<string>): BugCaseAssertion {
  const record = requireRecord(value, 'A check');
  const id = requireId(record.id);
  switch (record.kind) {
    case 'dom.text': {
      onlyKeys(record, ['id', 'kind', 'target', 'op', 'value', 'alsoAfterReload'], 'A text check');
      if (record.op !== 'equals' && record.op !== 'contains') throw new BugCaseValidationError('A text check has an unknown operation.');
      return {
        id,
        kind: 'dom.text',
        target: parseTarget(record.target),
        op: record.op,
        value: requireText(record.value, 'Expected text', 1),
        alsoAfterReload: requireBoolean(record.alsoAfterReload)
      };
    }
    case 'dom.value':
      onlyKeys(record, ['id', 'kind', 'target', 'value', 'alsoAfterReload'], 'A field check');
      return {
        id,
        kind: 'dom.value',
        target: parseTarget(record.target),
        value: requireText(record.value, 'Expected value', 0),
        alsoAfterReload: requireBoolean(record.alsoAfterReload)
      };
    case 'dom.visible':
      onlyKeys(record, ['id', 'kind', 'target', 'expected', 'alsoAfterReload'], 'A visibility check');
      return {
        id,
        kind: 'dom.visible',
        target: parseTarget(record.target),
        expected: requireBoolean(record.expected),
        alsoAfterReload: requireBoolean(record.alsoAfterReload)
      };
    case 'dom.count':
      onlyKeys(record, ['id', 'kind', 'target', 'value', 'alsoAfterReload'], 'A count check');
      return {
        id,
        kind: 'dom.count',
        target: parseTarget(record.target),
        value: requireInteger(record.value, 'An expected count', 0, 1000),
        alsoAfterReload: requireBoolean(record.alsoAfterReload)
      };
    case 'page.path':
      onlyKeys(record, ['id', 'kind', 'template'], 'A page check');
      return { id, kind: 'page.path', template: requirePathTemplate(record.template) };
    case 'request': {
      onlyKeys(record, ['id', 'kind', 'method', 'origin', 'pathTemplate', 'queryKeys', 'count', 'status'], 'A request check');
      const method = requireText(record.method, 'A request method', 3, 7);
      if (!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) {
        throw new BugCaseValidationError('A request check has an unsupported method.');
      }
      const origin = requireRole(record.origin);
      if (!roles.has(origin)) throw new BugCaseValidationError('A request check names an undeclared origin.');
      const queryKeys = requireArray(record.queryKeys, 'Query keys', 0, BUG_CASE_LIMITS.queryEntries).map((key) =>
        requireText(key, 'A query key', 1, 128)
      );
      if (new Set(queryKeys).size !== queryKeys.length) throw new BugCaseValidationError('Query keys repeat.');
      const count = requireRecord(record.count, 'A request count');
      onlyKeys(count, ['op', 'n'], 'A request count');
      if (count.op !== 'atLeast' && count.op !== 'exactly') throw new BugCaseValidationError('A request count has an unknown operation.');
      const parsed: BugCaseAssertion = {
        id,
        kind: 'request',
        method,
        origin,
        pathTemplate: requirePathTemplate(record.pathTemplate),
        queryKeys: [...queryKeys].sort(),
        count: { op: count.op, n: requireInteger(count.n, 'A request count', 0, 100) }
      };
      if (record.status !== undefined) {
        if (record.status === 'success' || record.status === 'answered') parsed.status = record.status;
        else parsed.status = requireInteger(record.status, 'A status', 100, 599);
      }
      return parsed;
    }
    case 'request.json': {
      onlyKeys(record, ['id', 'kind', 'requestId', 'side', 'pointer', 'equals'], 'A value check');
      if (record.side !== 'request' && record.side !== 'response') throw new BugCaseValidationError('A value check names an unknown side.');
      const pointer = requireText(record.pointer, 'A JSON pointer', 0, 256);
      if (pointer !== '' && !/^(?:\/(?:[^~/]|~[01])*)+$/.test(pointer)) {
        throw new BugCaseValidationError('A value check has an invalid JSON pointer.');
      }
      const equals = requireText(record.equals, 'An expected value', 1);
      try {
        JSON.parse(equals);
      } catch {
        throw new BugCaseValidationError('An expected value must be JSON.');
      }
      return { id, kind: 'request.json', requestId: requireId(record.requestId), side: record.side, pointer, equals };
    }
    case 'console.noUncaughtError':
      onlyKeys(record, ['id', 'kind'], 'A page error check');
      return { id, kind: 'console.noUncaughtError' };
    default:
      throw new BugCaseValidationError('A check has an unsupported kind.');
  }
}

function parseSignatureEntry(value: unknown): BugCaseSignatureEntry {
  const record = requireRecord(value, 'A signature entry');
  onlyKeys(record, ['assertionId', 'mode', 'captured'], 'A signature entry');
  if (record.mode !== 'CAPTURED' && record.mode !== 'ANY_MISMATCH') {
    throw new BugCaseValidationError('A signature entry has an unknown mode.');
  }
  const entry: BugCaseSignatureEntry = { assertionId: requireId(record.assertionId), mode: record.mode };
  if (record.captured !== undefined) entry.captured = parseCaptured(record.captured);
  return entry;
}

function parseCaptured(value: unknown): BugCaseCaptured {
  const record = requireRecord(value, 'A recorded observation');
  switch (record.kind) {
    case 'text':
      onlyKeys(record, ['kind', 'token'], 'A recorded text');
      return { kind: 'text', token: requireText(record.token, 'A recorded token', 1) };
    case 'value':
      onlyKeys(record, ['kind', 'value'], 'A recorded value');
      return { kind: 'value', value: requireText(record.value, 'A recorded value', 0) };
    case 'visible':
      onlyKeys(record, ['kind', 'value'], 'A recorded visibility');
      return { kind: 'visible', value: requireBoolean(record.value) };
    case 'count':
      onlyKeys(record, ['kind', 'value'], 'A recorded count');
      return { kind: 'count', value: requireInteger(record.value, 'A recorded count', 0, 1000) };
    case 'path':
      onlyKeys(record, ['kind', 'value'], 'A recorded path');
      return { kind: 'path', value: requirePath(record.value) };
    case 'status':
      onlyKeys(record, ['kind', 'value'], 'A recorded status');
      return {
        kind: 'status',
        value: record.value === 'no-response' ? 'no-response' : requireInteger(record.value, 'A recorded status', 100, 599)
      };
    case 'requestCount':
      onlyKeys(record, ['kind', 'value'], 'A recorded request count');
      return { kind: 'requestCount', value: requireInteger(record.value, 'A recorded request count', 0, 100) };
    case 'json': {
      onlyKeys(record, ['kind', 'value'], 'A recorded JSON value');
      if (record.value === null) return { kind: 'json', value: null };
      const json = requireText(record.value, 'A recorded JSON value', 1);
      try {
        JSON.parse(json);
      } catch {
        throw new BugCaseValidationError('A recorded JSON value is not JSON.');
      }
      return { kind: 'json', value: json };
    }
    default:
      throw new BugCaseValidationError('A recorded observation has an unknown kind.');
  }
}

function parseTarget(value: unknown): BugCaseTarget {
  const record = requireRecord(value, 'A target');
  onlyKeys(record, ['candidates', 'label'], 'A target');
  const candidates = requireArray(record.candidates, 'Target candidates', 1, BUG_CASE_LIMITS.candidates).map(
    (item): BugCaseTargetCandidate => {
      const candidate = requireRecord(item, 'A target candidate');
      switch (candidate.kind) {
        case 'testId': {
          onlyKeys(candidate, ['kind', 'attribute', 'value'], 'A test id');
          if (!BUG_CASE_TEST_ID_ATTRIBUTES.includes(candidate.attribute as BugCaseTestIdAttribute)) {
            throw new BugCaseValidationError('A test id names an unsupported attribute.');
          }
          return {
            kind: 'testId',
            attribute: candidate.attribute as BugCaseTestIdAttribute,
            value: requireText(candidate.value, 'A test id', 1, 512)
          };
        }
        case 'role': {
          onlyKeys(candidate, ['kind', 'role', 'name'], 'A role target');
          const role = requireText(candidate.role, 'A role', 1, 40);
          if (!/^[a-z]+$/.test(role)) throw new BugCaseValidationError('A role target has an invalid role.');
          return { kind: 'role', role, name: requireText(candidate.name, 'An accessible name', 0, 512) };
        }
        case 'label':
        case 'placeholder':
        case 'text':
          onlyKeys(candidate, ['kind', 'value'], 'A target');
          return { kind: candidate.kind, value: requireText(candidate.value, 'A target value', 1, 512) };
        case 'css': {
          onlyKeys(candidate, ['kind', 'value'], 'A CSS path');
          const css = requireText(candidate.value, 'A CSS path', 1, 2048);
          if (/[{};]|javascript:|expression\(|>>|internal:|xpath=|text=/i.test(css)) {
            throw new BugCaseValidationError('A CSS path holds unsupported syntax.');
          }
          return { kind: 'css', value: css };
        }
        default:
          throw new BugCaseValidationError('A target candidate has an unsupported kind.');
      }
    }
  );
  return record.label === undefined ? { candidates } : { candidates, label: requireText(record.label, 'A target name', 1, 80) };
}

function parseQuery(value: unknown): Array<[string, string]> {
  return requireArray(value, 'The query', 0, BUG_CASE_LIMITS.queryEntries).map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new BugCaseValidationError('A query entry must be a pair.');
    return [requireText(entry[0], 'A query key', 1, 128), requireText(entry[1], 'A query value', 0)];
  });
}

function requirePath(value: unknown): string {
  const path = requireText(value, 'A path', 1, BUG_CASE_LIMITS.pathChars);
  if (!path.startsWith('/') || path.startsWith('//') || /[\s#?\\]/.test(path)) {
    throw new BugCaseValidationError('A path must start with one slash and hold no query, fragment or spaces.');
  }
  return path;
}

function requirePathTemplate(value: unknown): string {
  const template = requirePath(value);
  for (const segment of template.split('/').slice(1)) {
    if (segment.includes('*') && segment !== '*') {
      throw new BugCaseValidationError('A path template wildcard replaces a whole segment.');
    }
  }
  return template;
}

function requireRole(value: unknown): string {
  const role = requireText(value, 'An origin role', 1, 64);
  if (!/^[a-z][a-z0-9_-]*$/.test(role)) throw new BugCaseValidationError('An origin role is not valid.');
  return role;
}

function requireId(value: unknown): string {
  const id = requireText(value, 'An id', 1, BUG_CASE_LIMITS.idChars);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new BugCaseValidationError('An id is not valid.');
  return id;
}

function requireText(value: unknown, label: string, min = 0, max: number = BUG_CASE_LIMITS.valueChars): string {
  if (typeof value !== 'string') throw new BugCaseValidationError(`${label} must be text.`);
  if (value.length < min) throw new BugCaseValidationError(`${label} is empty.`);
  if (value.length > max) throw new BugCaseValidationError(`${label} is too long.`);
  if (value.includes('\u0000')) throw new BugCaseValidationError(`${label} holds a NUL character.`);
  return value;
}

function requireInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BugCaseValidationError(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function requireNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BugCaseValidationError(`${label} must be a number from ${min} to ${max}.`);
  }
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new BugCaseValidationError('An option must be true or false.');
  return value;
}

function requireArray(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) throw new BugCaseValidationError(`${label} must be a list.`);
  if (value.length < min) throw new BugCaseValidationError(`${label} is empty.`);
  if (value.length > max) throw new BugCaseValidationError(`${label} holds more than ${max} items.`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BugCaseValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) throw new BugCaseValidationError(`${label} holds an unsupported field (${key.slice(0, 40)}).`);
  }
}

/** Matches a concrete path against a template whose `*` segments match any one segment. */
export function pathMatchesTemplate(path: string, template: string): boolean {
  const actual = path.split('/');
  const expected = template.split('/');
  if (actual.length !== expected.length) return false;
  return expected.every((segment, index) => segment === '*' || segment === actual[index]);
}

const ID_LIKE_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9A-HJKMNP-TV-Z]{26}$/,
  /^[0-9a-f]{16,}$/i,
  /^[A-Za-z0-9_-]{20,}$/
];

/** Replaces id-like segments (numbers, UUIDs, ULIDs, long hex or base64url runs) with `*`. */
export function pathTemplateFor(path: string): string {
  return path
    .split('/')
    .map((segment, index) => (index > 0 && ID_LIKE_SEGMENT.some((pattern) => pattern.test(segment)) ? '*' : segment))
    .join('/');
}

/** Reads a JSON pointer; `undefined` means the pointer does not resolve. */
export function readJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  let current: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (current && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** Canonical JSON of a value: object keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Whitespace-normalised visible text, as the runner and the compiler compare it. */
export function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The expected statement of one check, in words, for briefs and surfaces. */
export function describeBugCaseAssertion(assertion: BugCaseAssertion, document?: BugCaseV1): string {
  const statement = describeAssertionOnce(assertion, document);
  return isDomAssertion(assertion) && assertion.alsoAfterReload ? `${statement}, also after reload` : statement;
}

function describeAssertionOnce(assertion: BugCaseAssertion, document?: BugCaseV1): string {
  switch (assertion.kind) {
    case 'dom.text':
      return assertion.op === 'equals'
        ? `${describeTarget(assertion.target)} should read "${assertion.value}"`
        : `${describeTarget(assertion.target)} should contain "${assertion.value}"`;
    case 'dom.value':
      return `${describeTarget(assertion.target)} should hold "${assertion.value}"`;
    case 'dom.visible':
      return `${describeTarget(assertion.target)} should ${assertion.expected ? 'be visible' : 'not be visible'}`;
    case 'dom.count':
      return `${describeTarget(assertion.target)} should appear ${assertion.value} ${assertion.value === 1 ? 'time' : 'times'}`;
    case 'page.path':
      return `The page should be ${assertion.template}`;
    case 'request': {
      const request = `${assertion.method} ${assertion.pathTemplate}`;
      if (assertion.count.op === 'exactly' && assertion.count.n === 0) return `${request} should not be sent`;
      if (assertion.count.op === 'exactly') return `${request} should be sent ${assertion.count.n === 1 ? 'once' : `${assertion.count.n} times`}`;
      if (assertion.status === 'success') return `${request} should succeed`;
      if (assertion.status === 'answered') return `${request} should be answered`;
      if (typeof assertion.status === 'number') return `${request} should return ${assertion.status}`;
      return `${request} should be sent`;
    }
    case 'request.json': {
      const anchor = document?.assertions.find((candidate) => candidate.id === assertion.requestId);
      const request = anchor && anchor.kind === 'request' ? `${anchor.method} ${anchor.pathTemplate}` : 'The request';
      const field = assertion.pointer ? assertion.pointer.slice(1).replace(/\//g, '.') : 'body';
      return `${request} should ${assertion.side === 'request' ? 'send' : 'return'} ${field} = ${assertion.equals}`;
    }
    case 'console.noUncaughtError':
      return 'The page should raise no error';
  }
}

/** A short human name for a target, from its most readable candidate. */
export function describeTarget(target: BugCaseTarget): string {
  if (target.label) return `"${truncate(target.label, 48)}"`;
  for (const candidate of target.candidates) {
    if (candidate.kind === 'role' && candidate.name) return `"${truncate(candidate.name, 48)}"`;
    if (candidate.kind === 'label' || candidate.kind === 'placeholder') return `"${truncate(candidate.value, 48)}"`;
  }
  for (const candidate of target.candidates) {
    if (candidate.kind === 'testId') return `"${truncate(testIdWords(candidate.value), 48)}"`;
    if (candidate.kind === 'text') return `"${truncate(candidate.value, 48)}"`;
  }
  return 'The element';
}

/** A test id read as words: "order-status" and "orderStatus" both name "Order status". */
export function testIdWords(value: string): string {
  const words = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_.:]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
