import {
  BUG_CASE_KEYS,
  BUG_CASE_SCHEMA,
  BugCaseValidationError,
  canonicalJson,
  describeBugCaseAssertion,
  describeTarget,
  isPositiveAssertion,
  isRequiredPath,
  normalizeVisibleText,
  pathTemplateFor,
  readJsonPointer,
  testIdWords,
  validateBugCaseStructure,
  type BugCaseAssertion,
  type BugCaseCaptured,
  type BugCaseKey,
  type BugCaseSignatureEntry,
  type BugCaseStep,
  type BugCaseTarget,
  type BugCaseTargetCandidate,
  type BugCaseV1
} from '../../shared/bugCase';
import type {
  BugRecordingAction,
  BugRecordingLogV1,
  BugRecordingPick,
  BugRecordingRequest,
  BugRecordingTargetFacts
} from '../../shared/bugRecording';
import type {
  BugCaptureDraft,
  BugCapturePickView,
  BugCaptureRequestRow,
  BugCaptureValueRow,
  BugCaseCheckView,
  BugStepKind
} from '../../shared/bugReplay';
import { suggestBugTitle, type BugTitleSeed } from '../../shared/bugReplayClaims';

/**
 * Pure compiler from a sealed recording and the person's checks to a `bug-case/v1` document.
 * The failure signature is exactly the set of checks the recording itself violated, so a
 * reproduction means "the clean copy failed the way the person saw it fail".
 */

export const BUG_CASE_COMPILER_VERSION = 'bug-case-compiler/1';

/** Requests the capture modal and the case consider: what the page asked the app for. */
const COUNTED_RESOURCE_TYPES = new Set(['fetch', 'xhr', 'document', 'eventsource', 'other']);

export interface CompiledCapture {
  picks: BugCapturePickView[];
  requests: BugCaptureRequestRow[];
  valueRows: BugCaptureValueRow[];
  otherRequests: string[];
  pageErrors: string[];
  /** The marked window raised an uncaught error, so "No page error" can reproduce. */
  uncaughtError: boolean;
  stepSummaries: string[];
  /** What each step does, beside its summary. */
  stepKinds: BugStepKind[];
  suggestedTitle: string;
  /** Why the recording cannot become an executable case at all. */
  partial?: string;
}

export interface CompiledCase {
  document?: BugCaseV1;
  checks: BugCaseCheckView[];
  reproducible: boolean;
  reason?: string;
}

interface MarkedWindow {
  actions: BugRecordingAction[];
  markedAction: BugRecordingAction;
  requests: BugRecordingRequest[];
}

/** What the modal shows for a sealed recording, before the person has chosen anything. */
export function describeCapture(log: BugRecordingLogV1, pageTitle?: string): CompiledCapture {
  const partial = partialReason(log);
  const window = markedWindow(log);
  const picks = (log.mark?.picks ?? []).map((pick, index) => pickView(pick, index));
  const requests = window ? requestRows(window.requests) : [];
  const valueRows = window ? candidateValueRows(window.requests, log.mark?.picks ?? []) : [];
  const otherRequests = window
    ? window.requests
        .filter((request) => !request.role || !COUNTED_RESOURCE_TYPES.has(request.resourceType))
        .slice(0, 20)
        .map((request) =>
          request.role
            ? `${request.method} ${request.path} ${observedStatus(request)}`
            : `Blocked ${request.method} ${request.host ?? 'an outside host'}`
        )
    : [];
  const markT = log.mark?.t ?? Number.POSITIVE_INFINITY;
  const pageErrors = log.console
    .filter((entry) => (entry.level === 'error' || entry.level === 'exception') && entry.t <= markT)
    .slice(-10)
    .map((entry) => entry.text.slice(0, 240));
  const steps = window ? compileSteps(window.actions) : { steps: [], sensitiveInputs: [], times: [] };
  void pageTitle;
  return {
    picks,
    requests,
    valueRows,
    otherRequests,
    pageErrors,
    uncaughtError: window ? uncaughtIn(log, window) : false,
    stepSummaries: steps.steps.map((step) => describeStep(step)),
    stepKinds: steps.steps.map((step) => step.kind),
    suggestedTitle: suggestBugTitle(picks[0] ? titleSeed(picks[0]) : undefined),
    ...(partial ? { partial } : {})
  };
}

/**
 * Compiles the person's draft into a case. Returns the document with `reproducible` when at
 * least one check was violated by the recording; otherwise the capture can only be saved as
 * evidence, with the reason.
 */
export function compileBugCase(log: BugRecordingLogV1, draft: BugCaptureDraft): CompiledCase {
  const partial = partialReason(log);
  const window = markedWindow(log);
  if (!window || !log.mark) {
    return { checks: [], reproducible: false, reason: 'Mark the bug first.' };
  }
  if (partial) return { checks: [], reproducible: false, reason: partial };
  const { steps, sensitiveInputs } = compileSteps(window.actions);
  const assertions: BugCaseAssertion[] = [];
  const signature: BugCaseSignatureEntry[] = [];
  let next = 1;
  const nextId = (prefix: string) => `${prefix}${next++}`;

  // The first check the recording already satisfies, to say what to change when nothing was wrong.
  let alreadyHolds: string | undefined;
  for (const check of draft.checks) {
    const pick = log.mark.picks[check.pickIndex];
    if (!pick) continue;
    const assertion = domAssertion(check, pick, nextId('a'));
    if (!assertion) continue;
    assertions.push(assertion);
    const entry = domSignature(assertion, pick);
    if (entry) signature.push(entry);
    else if (!alreadyHolds && (assertion.kind === 'dom.text' || assertion.kind === 'dom.value')) {
      const shown = assertion.kind === 'dom.value' ? pick.value ?? '' : normalizeVisibleText(pick.text);
      const subject = describeTarget(assertion.target);
      alreadyHolds = `Write what ${subject === 'The element' ? 'it' : subject} should read; it shows "${shown.slice(0, 60)}" now`;
    }
  }

  // Page errors count from the marked action on, in the recording as in a replay: an error that
  // action raised is the failure; with none, the check guards the fix.
  if (draft.noPageError) {
    const assertion: BugCaseAssertion = { id: nextId('c'), kind: 'console.noUncaughtError' };
    assertions.push(assertion);
    if (uncaughtIn(log, window)) signature.push({ assertionId: assertion.id, mode: 'ANY_MISMATCH' });
  }

  const rows = requestRows(window.requests);
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const requestAssertionByKey = new Map<string, string>();
  const ensureRequestAssertion = (key: string, check: 'success' | 'answered'): string | undefined => {
    const existing = requestAssertionByKey.get(key);
    if (existing) return existing;
    const row = rowByKey.get(key);
    if (!row) return undefined;
    const assertion: BugCaseAssertion = {
      id: nextId('r'),
      kind: 'request',
      method: row.method,
      origin: row.role,
      pathTemplate: row.pathTemplate,
      queryKeys: row.queryKeys,
      count: { op: 'atLeast', n: 1 },
      status: check
    };
    assertions.push(assertion);
    requestAssertionByKey.set(key, assertion.id);
    const matching = window.requests.filter((request) => requestKey(request) === key);
    const statusEntry = requestStatusSignature(assertion, matching);
    if (statusEntry) signature.push(statusEntry);
    return assertion.id;
  };

  for (const rule of draft.requestRules) {
    const row = rowByKey.get(rule.requestKey);
    if (!row) continue;
    if (rule.check !== 'none') ensureRequestAssertion(rule.requestKey, rule.check);
    if (rule.sentOnce) {
      const assertion: BugCaseAssertion = {
        id: nextId('r'),
        kind: 'request',
        method: row.method,
        origin: row.role,
        pathTemplate: row.pathTemplate,
        queryKeys: row.queryKeys,
        count: { op: 'exactly', n: 1 }
      };
      assertions.push(assertion);
      if (row.count !== 1) {
        signature.push({ assertionId: assertion.id, mode: 'CAPTURED', captured: { kind: 'requestCount', value: row.count } });
      }
    }
  }

  for (const valueCheck of draft.valueChecks) {
    const row = rowByKey.get(valueCheck.requestKey);
    if (!row) continue;
    let expected: unknown;
    try {
      expected = JSON.parse(valueCheck.expected);
    } catch {
      return { checks: [], reproducible: false, reason: `The expected value for ${row.method} ${row.pathTemplate} is not valid.` };
    }
    const rule = draft.requestRules.find((candidate) => candidate.requestKey === valueCheck.requestKey);
    const anchorCheck = rule && rule.check !== 'none' ? rule.check : row.succeeded ? 'answered' : 'success';
    const anchorId = ensureRequestAssertion(valueCheck.requestKey, anchorCheck);
    if (!anchorId) continue;
    const assertion: BugCaseAssertion = {
      id: nextId('v'),
      kind: 'request.json',
      requestId: anchorId,
      side: valueCheck.side,
      pointer: valueCheck.pointer,
      equals: canonicalJson(expected)
    };
    assertions.push(assertion);
    const matching = window.requests.filter((request) => requestKey(request) === valueCheck.requestKey);
    const observed = firstDifferingJson(matching, assertion.side, assertion.pointer, assertion.equals);
    if (observed !== undefined) {
      signature.push({ assertionId: assertion.id, mode: 'CAPTURED', captured: { kind: 'json', value: observed } });
    }
  }

  const document: BugCaseV1 = {
    schema: BUG_CASE_SCHEMA,
    origins: log.roles.map((role) => ({ role })),
    environment: log.environment,
    steps,
    assertions,
    failureSignature: signature,
    sensitiveInputs,
    keepBrowserStorageAfterReload: false
  };
  const checks = checkViews(document);
  if (assertions.length === 0) return { checks, reproducible: false, reason: 'Add an expectation first' };
  if (signature.length === 0) {
    return { checks, reproducible: false, reason: alreadyHolds ?? 'Nothing you expect was wrong in the recording' };
  }
  try {
    validateBugCaseStructure(document);
  } catch (error) {
    const reason = error instanceof BugCaseValidationError ? error.reason : 'These expectations cannot be reproduced.';
    return { checks, reproducible: false, reason: reason.replace(/\.$/, '') };
  }
  return { document, checks, reproducible: true };
}

/** The checks as the modal and the Bug section state them. */
export function checkViews(document: BugCaseV1): BugCaseCheckView[] {
  const signature = new Map(document.failureSignature.map((entry) => [entry.assertionId, entry]));
  return document.assertions.map((assertion) => {
    const entry = signature.get(assertion.id);
    const view: BugCaseCheckView = {
      id: assertion.id,
      statement: describeBugCaseAssertion(assertion, document),
      inSignature: Boolean(entry)
    };
    if (entry?.captured) view.recorded = describeCaptured(entry.captured);
    else if (entry) view.recorded = 'Did not hold in the recording';
    return view;
  });
}

export function describeCaptured(captured: BugCaseCaptured): string {
  switch (captured.kind) {
    case 'text':
      return `Showed "${captured.token}"`;
    case 'value':
      return `Held "${captured.value}"`;
    case 'visible':
      return captured.value ? 'Was visible' : 'Was not visible';
    case 'count':
      return `Appeared ${captured.value} ${captured.value === 1 ? 'time' : 'times'}`;
    case 'path':
      return `Was ${captured.value}`;
    case 'status':
      return captured.value === 'no-response' ? 'Got no response' : `Returned ${captured.value}`;
    case 'requestCount':
      return `Was sent ${captured.value} ${captured.value === 1 ? 'time' : 'times'}`;
    case 'json':
      return captured.value === null ? 'Had no value' : `Was ${captured.value}`;
  }
}

function partialReason(log: BugRecordingLogV1): string | undefined {
  if (!log.mark) return undefined;
  const marked = log.actions.slice(0, log.mark.actionIndex + 1);
  const unsupported = marked.find((action) => action.kind === 'unsupported');
  if (unsupported) {
    return `Step ${stepNumberFor(marked, unsupported.index)} can't be replayed (${unsupported.unsupported ?? 'unsupported input'})`;
  }
  if (!log.coverage.complete) return log.coverage.reasons[0] ?? 'The recording is incomplete';
  if (marked.length === 0 || marked[0].kind !== 'navigate') return 'The recording has no clean start';
  return undefined;
}

function stepNumberFor(actions: BugRecordingAction[], index: number): number {
  return actions.filter((action) => action.index <= index && action.kind !== 'dialog').length;
}

function markedWindow(log: BugRecordingLogV1): MarkedWindow | undefined {
  if (!log.mark) return undefined;
  const actions = log.actions.slice(0, log.mark.actionIndex + 1);
  const markedAction = [...actions].reverse().find((action) => action.kind !== 'dialog');
  if (!markedAction) return undefined;
  const startT = markedAction.t;
  const endT = log.mark.window.endT;
  const requests = log.requests.filter((request) => request.t >= startT && request.t <= endT);
  return { actions, markedAction, requests };
}

interface CompiledSteps {
  steps: BugCaseStep[];
  sensitiveInputs: Array<{ id: string; value: string }>;
  /** When each step's last action happened, in the recording's milliseconds. */
  times: number[];
}

/** Actions become steps in order; consecutive clicks on one target within 500ms become one click. */
export function compileSteps(actions: BugRecordingAction[]): CompiledSteps {
  const steps: BugCaseStep[] = [];
  const sensitiveInputs: Array<{ id: string; value: string }> = [];
  const times: number[] = [];
  let lastClick: { step: Extract<BugCaseStep, { kind: 'click' }>; t: number; css: string; times: number[] } | undefined;
  let stepNumber = 0;
  const id = () => `s${++stepNumber}`;
  for (const action of actions) {
    if (action.kind !== 'click') lastClick = undefined;
    const countBefore = steps.length;
    const lastBefore = steps[steps.length - 1];
    switch (action.kind) {
      case 'navigate':
        if (steps.length === 0 && action.location) {
          steps.push({ id: id(), kind: 'navigate', origin: action.location.role, path: action.location.path, query: action.location.query });
        }
        break;
      case 'reload':
        if (steps.length > 0) steps.push({ id: id(), kind: 'reload' });
        break;
      case 'click': {
        if (!action.target) break;
        if (lastClick && lastClick.css === action.target.css && action.t - lastClick.t <= 500 && lastClick.times.length < 3) {
          lastClick.times.push(action.t);
          lastClick.step.count = lastClick.times.length as 2 | 3;
          lastClick.step.intervalMs = Math.max(0, Math.min(500, Math.round((action.t - lastClick.times[0]) / (lastClick.times.length - 1))));
          lastClick.t = action.t;
          break;
        }
        const step: Extract<BugCaseStep, { kind: 'click' }> = { id: id(), kind: 'click', target: stepTarget(action.target) };
        steps.push(step);
        lastClick = { step, t: action.t, css: action.target.css, times: [action.t] };
        break;
      }
      case 'check':
      case 'uncheck':
        if (action.target) steps.push({ id: id(), kind: action.kind, target: stepTarget(action.target) });
        break;
      case 'fill': {
        if (!action.target) break;
        const previous = steps[steps.length - 1];
        const target = stepTarget(action.target);
        const sameField = previous?.kind === 'fill' && sameTarget(previous.target, target);
        if (action.sensitive) {
          const sensitiveId = `p${sensitiveInputs.length + 1}`;
          sensitiveInputs.push({ id: sensitiveId, value: action.value ?? '' });
          const step: BugCaseStep = { id: sameField ? previous.id : id(), kind: 'fill', target, sensitiveRef: sensitiveId };
          if (sameField) steps[steps.length - 1] = step;
          else steps.push(step);
        } else {
          const step: BugCaseStep = { id: sameField ? previous.id : id(), kind: 'fill', target, value: action.value ?? '' };
          if (sameField) steps[steps.length - 1] = step;
          else steps.push(step);
        }
        break;
      }
      case 'select':
        if (action.target) steps.push({ id: id(), kind: 'select', target: stepTarget(action.target), values: action.values ?? [] });
        break;
      case 'press':
        if (action.key && (BUG_CASE_KEYS as readonly string[]).includes(action.key)) {
          steps.push({ id: id(), kind: 'press', key: action.key as BugCaseKey });
        }
        break;
      case 'dialog':
        if (action.dialog && steps.length > 0) {
          const step: BugCaseStep = { id: id(), kind: 'dialog', action: action.dialog.action };
          if (action.dialog.promptText !== undefined) step.promptText = action.dialog.promptText;
          steps.push(step);
        }
        break;
      case 'unsupported':
        break;
    }
    // The step this action made or changed: a merged click or field keeps its latest time.
    const changed = steps.length !== countBefore || steps[steps.length - 1] !== lastBefore || (action.kind === 'click' && lastClick?.t === action.t);
    if (steps.length > 0 && changed) times[steps.length - 1] = action.t;
  }
  return { steps, sensitiveInputs, times };
}

function sameTarget(left: BugCaseTarget, right: BugCaseTarget): boolean {
  const leftCss = left.candidates.find((candidate) => candidate.kind === 'css');
  const rightCss = right.candidates.find((candidate) => candidate.kind === 'css');
  return Boolean(leftCss && rightCss && leftCss.value === rightCss.value);
}

/** Candidates for an element a step acts on, most stable first. */
export function stepTarget(facts: BugRecordingTargetFacts): BugCaseTarget {
  const candidates: BugCaseTargetCandidate[] = [];
  for (const testId of facts.testIds) candidates.push({ kind: 'testId', attribute: testId.attribute, value: testId.value });
  if (facts.role && facts.name && facts.name.length <= 200) candidates.push({ kind: 'role', role: facts.role, name: facts.name });
  if (facts.label && facts.label.length <= 200) candidates.push({ kind: 'label', value: facts.label });
  if (facts.placeholder && facts.placeholder.length <= 200) candidates.push({ kind: 'placeholder', value: facts.placeholder });
  if (facts.text && facts.text.length <= 80 && isTextTargetable(facts) && !facts.role) {
    candidates.push({ kind: 'text', value: facts.text });
  }
  candidates.push({ kind: 'css', value: facts.css });
  return { candidates: dedupeCandidates(candidates).slice(0, 8) };
}

/**
 * Candidates for an element a check reads. Text and names that contain what the check reads
 * are left out: a correct fix changes exactly that text.
 */
export function checkTarget(facts: BugRecordingTargetFacts, observedText: string): BugCaseTarget {
  const observed = normalizeVisibleText(observedText);
  const candidates: BugCaseTargetCandidate[] = [];
  for (const testId of facts.testIds) candidates.push({ kind: 'testId', attribute: testId.attribute, value: testId.value });
  if (facts.role && facts.name && facts.name.length <= 200 && !overlaps(facts.name, observed)) {
    candidates.push({ kind: 'role', role: facts.role, name: facts.name });
  }
  if (facts.label && facts.label.length <= 200 && !overlaps(facts.label, observed)) candidates.push({ kind: 'label', value: facts.label });
  if (facts.placeholder && facts.placeholder.length <= 200) candidates.push({ kind: 'placeholder', value: facts.placeholder });
  candidates.push({ kind: 'css', value: facts.css });
  const target: BugCaseTarget = { candidates: dedupeCandidates(candidates).slice(0, 8) };
  // The same name the pick showed, so the check, the evidence and the pick agree.
  const label = elementName(facts, observedText);
  if (label) target.label = label;
  return target;
}

/**
 * What people call an element, in one form for the pick, its checks and their evidence: its
 * label or accessible name, its test id read as words (a name someone chose), the words beside
 * it on its line, or its placeholder. Never text that repeats what a check reads, since a fix
 * changes exactly that.
 */
export function elementName(facts: BugRecordingTargetFacts, observedText = ''): string | undefined {
  const observed = normalizeVisibleText(observedText);
  const usable = (value: string | undefined) => {
    const name = value ? normalizeVisibleText(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ')) : '';
    return name && name.length <= 60 && !overlaps(name, observed) ? name : undefined;
  };
  return usable(facts.label)
    ?? (facts.role ? usable(facts.name) : undefined)
    ?? usable(facts.testIds[0] ? testIdWords(facts.testIds[0].value) : undefined)
    ?? usable(facts.context)
    ?? usable(facts.placeholder);
}

function overlaps(name: string, observed: string): boolean {
  if (!observed) return false;
  const normalized = normalizeVisibleText(name);
  return normalized.includes(observed) || (observed.length > 0 && observed.includes(normalized) && normalized.length > 0);
}

function isTextTargetable(facts: BugRecordingTargetFacts): boolean {
  return ['button', 'a', 'summary', 'label', 'li', 'span', 'div', 'td', 'th'].includes(facts.tag);
}

function dedupeCandidates(candidates: BugCaseTargetCandidate[]): BugCaseTargetCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function domAssertion(
  check: BugCaptureDraft['checks'][number],
  pick: BugRecordingPick,
  id: string
): BugCaseAssertion | undefined {
  const target = checkTarget(pick.target, pick.text);
  const isField = pick.value !== undefined && ['input', 'textarea', 'select'].includes(pick.target.tag);
  switch (check.template) {
    case 'equals':
    case 'contains': {
      const expected = normalizeVisibleText(check.expected ?? '');
      if (!expected && !isField) return undefined;
      if (isField && check.template === 'equals') {
        return { id, kind: 'dom.value', target, value: check.expected ?? '', alsoAfterReload: check.alsoAfterReload };
      }
      if (!expected) return undefined;
      return { id, kind: 'dom.text', target, op: check.template, value: expected, alsoAfterReload: check.alsoAfterReload };
    }
    case 'visible':
      return { id, kind: 'dom.visible', target, expected: true, alsoAfterReload: check.alsoAfterReload };
    case 'hidden':
      return { id, kind: 'dom.visible', target, expected: false, alsoAfterReload: check.alsoAfterReload };
    case 'count': {
      const value = check.count ?? 1;
      if (!Number.isInteger(value) || value < 0 || value > 1000) return undefined;
      return { id, kind: 'dom.count', target, value, alsoAfterReload: check.alsoAfterReload };
    }
  }
}

/** The signature entry for a DOM check, when the recording violated it. */
function domSignature(assertion: BugCaseAssertion, pick: BugRecordingPick): BugCaseSignatureEntry | undefined {
  switch (assertion.kind) {
    case 'dom.text': {
      const observed = normalizeVisibleText(pick.text);
      const holds = assertion.op === 'equals' ? observed === assertion.value : observed.includes(assertion.value);
      if (holds && pick.visible) return undefined;
      if (!pick.visible) return { assertionId: assertion.id, mode: 'ANY_MISMATCH' };
      const token = differingToken(observed, assertion.value);
      if (!token || isVolatileToken(token)) return { assertionId: assertion.id, mode: 'ANY_MISMATCH' };
      return { assertionId: assertion.id, mode: 'CAPTURED', captured: { kind: 'text', token } };
    }
    case 'dom.value': {
      if ((pick.value ?? '') === assertion.value) return undefined;
      return { assertionId: assertion.id, mode: 'CAPTURED', captured: { kind: 'value', value: pick.value ?? '' } };
    }
    case 'dom.visible':
      if (pick.visible === assertion.expected) return undefined;
      return { assertionId: assertion.id, mode: 'CAPTURED', captured: { kind: 'visible', value: pick.visible } };
    case 'dom.count':
      if (pick.count === assertion.value) return undefined;
      return { assertionId: assertion.id, mode: 'CAPTURED', captured: { kind: 'count', value: pick.count } };
    default:
      return undefined;
  }
}

/**
 * The run of tokens in `observed` that the expectation replaced, with common leading and
 * trailing tokens removed: "Total $40.00" against "Total $45.00" gives "$40.00".
 */
export function differingToken(observed: string, expected: string): string | undefined {
  const left = observed.split(' ').filter(Boolean);
  const right = expected.split(' ').filter(Boolean);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let end = 0;
  while (
    end < left.length - start &&
    end < right.length - start &&
    left[left.length - 1 - end] === right[right.length - 1 - end]
  ) {
    end += 1;
  }
  const token = left.slice(start, left.length - end).join(' ');
  return token || undefined;
}

const VOLATILE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?\b/,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b[0-9A-HJKMNP-TV-Z]{26}\b/,
  /\b[0-9a-f]{8,}\b/i,
  /#\d{3,}\b/,
  /\b\d{6,}\b/,
  /\b(?:just now|seconds? ago|minutes? ago|hours? ago|days? ago)\b/i
];

export function isVolatileToken(token: string): boolean {
  return VOLATILE_PATTERNS.some((pattern) => pattern.test(token));
}

/** Tokens of a picked text that look like dates, times or ids. */
export function volatileTokens(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of VOLATILE_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(global)) {
      if (match[0].trim()) found.add(match[0].trim());
    }
  }
  return [...found].slice(0, 12);
}

function pickView(pick: BugRecordingPick, index: number): BugCapturePickView {
  return {
    index,
    target: pick.target,
    text: normalizeVisibleText(pick.text).slice(0, 2000),
    ...(pick.value === undefined ? {} : { value: pick.value }),
    visible: pick.visible,
    count: pick.count,
    volatileTokens: volatileTokens(pick.text),
    label: elementName(pick.target, pick.value ?? pick.text) ?? tagWord(pick.target.tag),
    ...(pick.box ? { box: pick.box } : {})
  };
}

/** An element with no name, by what it is. */
function tagWord(tag: string): string {
  if (/^h[1-6]$/.test(tag)) return 'Heading';
  const words: Record<string, string> = { a: 'Link', button: 'Button', input: 'Field', textarea: 'Field', select: 'Menu', img: 'Image', li: 'List item', td: 'Table cell', th: 'Table heading', label: 'Label' };
  return words[tag] ?? 'Text';
}

/** The first expectation a pick gets by default, as a title seed: what it showed, not yet what it should. */
function titleSeed(pick: BugCapturePickView): BugTitleSeed {
  const shown = pick.value ?? pick.text;
  if (shown) return { label: pick.label, template: 'equals', expected: shown, shown };
  return { label: pick.label, template: pick.visible ? 'hidden' : 'visible' };
}

/**
 * Whether the marked action raised an uncaught error before the bug was marked: from the action's
 * start (a fill's first keystroke, the start page's load) to the mark, the span a replay counts.
 */
function uncaughtIn(log: BugRecordingLogV1, window: MarkedWindow): boolean {
  const end = log.mark?.t ?? Number.POSITIVE_INFINITY;
  return log.console.some((entry) => entry.level === 'exception' && entry.t >= window.markedAction.t && entry.t <= end);
}

export function requestKey(request: Pick<BugRecordingRequest, 'method' | 'role' | 'path' | 'queryKeys'>): string {
  return `${request.method} ${request.role ?? '?'} ${pathTemplateFor(request.path)}${request.queryKeys.length ? `?${[...request.queryKeys].sort().join('&')}` : ''}`;
}

function observedStatus(request: BugRecordingRequest): string {
  if (request.outcome === 'response' && !request.gateway && request.status !== undefined) return String(request.status);
  return 'no response';
}

function succeeded(request: BugRecordingRequest): boolean {
  return request.outcome === 'response' && !request.gateway && request.status !== undefined && request.status >= 200 && request.status < 400;
}

/** Rows for every declared-origin request the marked action started, grouped by method and path template. */
export function requestRows(requests: BugRecordingRequest[]): BugCaptureRequestRow[] {
  const rows = new Map<string, BugCaptureRequestRow & { all: BugRecordingRequest[] }>();
  for (const request of requests) {
    if (!request.role || !COUNTED_RESOURCE_TYPES.has(request.resourceType) || request.fromServiceWorker) continue;
    const key = requestKey(request);
    const existing = rows.get(key);
    if (existing) {
      existing.count += 1;
      existing.all.push(request);
      continue;
    }
    rows.set(key, {
      key,
      method: request.method,
      role: request.role,
      pathTemplate: pathTemplateFor(request.path),
      path: request.path,
      queryKeys: [...request.queryKeys].sort(),
      observed: observedStatus(request),
      count: 1,
      succeeded: false,
      defaultCheck: 'none',
      defaultSentOnce: false,
      all: [request]
    });
  }
  return [...rows.values()].map(({ all, ...row }) => {
    const allSucceeded = all.every(succeeded);
    const isWrite = row.method !== 'GET' && row.method !== 'HEAD' && row.method !== 'OPTIONS';
    const failing = all.find((request) => !succeeded(request));
    return {
      ...row,
      observed: failing ? observedStatus(failing) : row.observed,
      succeeded: allSucceeded,
      // A server error is almost always the bug; a 4xx answer is often what the app means to
      // say, so a write is only required to get an answer the person can change to success.
      defaultCheck: isWrite ? 'answered' : 'none',
      defaultSentOnce: isWrite && row.count === 1
    };
  });
}

/** The status signature of a required request, when the recording violated it. */
function requestStatusSignature(
  assertion: Extract<BugCaseAssertion, { kind: 'request' }>,
  matching: BugRecordingRequest[]
): BugCaseSignatureEntry | undefined {
  if (matching.length === 0) {
    return { assertionId: assertion.id, mode: 'CAPTURED', captured: { kind: 'requestCount', value: 0 } };
  }
  const violating = matching.find((request) => !statusHolds(assertion.status, request));
  if (!violating) return undefined;
  const value: number | 'no-response' =
    violating.outcome === 'response' && !violating.gateway && violating.status !== undefined ? violating.status : 'no-response';
  return { assertionId: assertion.id, mode: 'CAPTURED', captured: { kind: 'status', value } };
}

export function statusHolds(
  rule: 'success' | 'answered' | number | undefined,
  request: Pick<BugRecordingRequest, 'outcome' | 'gateway' | 'status'>
): boolean {
  if (rule === undefined) return true;
  const answered = request.outcome === 'response' && !request.gateway && request.status !== undefined;
  if (!answered) return false;
  if (rule === 'success') return request.status! >= 200 && request.status! < 400;
  if (rule === 'answered') return request.status! < 500;
  return request.status === rule;
}

function firstDifferingJson(
  matching: BugRecordingRequest[],
  side: 'request' | 'response',
  pointer: string,
  expected: string
): string | null | undefined {
  for (const request of matching) {
    const body = side === 'request' ? request.requestJson : request.responseJson;
    if (body === undefined) continue;
    const value = readJsonPointer(body, pointer);
    if (value === undefined) {
      if (side === 'response') return null;
      continue;
    }
    const canonical = canonicalJson(value);
    if (canonical !== expected) return canonical;
  }
  return undefined;
}

/** Scalars in the marked action's JSON bodies that equal a number in a picked element's text. */
function candidateValueRows(requests: BugRecordingRequest[], picks: BugRecordingPick[]): BugCaptureValueRow[] {
  const wanted = new Set<number>();
  for (const pick of picks) for (const number of numbersIn(pick.text)) wanted.add(number);
  if (wanted.size === 0) return [];
  const rows: BugCaptureValueRow[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (!request.role) continue;
    const key = requestKey(request);
    for (const side of ['request', 'response'] as const) {
      const body = side === 'request' ? request.requestJson : request.responseJson;
      if (body === undefined) continue;
      for (const { pointer, value } of scalars(body)) {
        const number = scalarNumber(value);
        if (number === undefined) continue;
        const matches = [...wanted].some((candidate) => candidate === number || Math.round(candidate * 100) === number);
        if (!matches) continue;
        const rowKey = `${key} ${side} ${pointer}`;
        if (seen.has(rowKey)) continue;
        seen.add(rowKey);
        rows.push({ requestKey: key, side, pointer, observed: canonicalJson(value) });
        if (rows.length >= 20) return rows;
      }
    }
  }
  return rows;
}

/**
 * The expected value for a value row, written in the observed value's representation:
 * 40 → 45, "40.00" → "45.00", 4000 (cents) → 4500.
 */
export function suggestValue(observed: string, observedNumberInText: number | undefined, expectedText: string): string | undefined {
  const expectedNumbers = numbersIn(expectedText);
  if (expectedNumbers.length === 0) return undefined;
  const expected = expectedNumbers[0];
  let value: unknown;
  try {
    value = JSON.parse(observed);
  } catch {
    return undefined;
  }
  const asNumber = scalarNumber(value);
  if (asNumber === undefined) return undefined;
  const cents = observedNumberInText !== undefined && Math.round(observedNumberInText * 100) === asNumber && asNumber !== observedNumberInText;
  const target = cents ? Math.round(expected * 100) : expected;
  if (typeof value === 'number') return canonicalJson(target);
  if (typeof value === 'string') {
    const decimals = value.includes('.') ? value.split('.')[1].length : 0;
    return canonicalJson(decimals > 0 ? target.toFixed(decimals) : String(target));
  }
  return undefined;
}

/** Numbers written in a text: "$1,234.50 and 3" gives [1234.5, 3]. */
export function numbersIn(text: string): number[] {
  const numbers: number[] = [];
  for (const match of text.matchAll(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (Number.isFinite(value)) numbers.push(value);
  }
  return numbers.slice(0, 8);
}

function scalarNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function scalars(document: unknown, pointer = '', depth = 0, out: Array<{ pointer: string; value: unknown }> = []): Array<{ pointer: string; value: unknown }> {
  if (out.length >= 200 || depth > 8) return out;
  if (document === null || typeof document !== 'object') {
    out.push({ pointer, value: document });
    return out;
  }
  if (Array.isArray(document)) {
    document.slice(0, 50).forEach((item, index) => scalars(item, `${pointer}/${index}`, depth + 1, out));
    return out;
  }
  for (const [key, value] of Object.entries(document as Record<string, unknown>).slice(0, 100)) {
    scalars(value, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1, out);
  }
  return out;
}

/** Up to 20 scalar fields of a body, for Check a value. */
export function bodyFields(document: unknown): Array<{ pointer: string; value: string }> {
  return scalars(document)
    .filter((entry) => entry.pointer !== '')
    .slice(0, 20)
    .map((entry) => ({ pointer: entry.pointer, value: canonicalJson(entry.value) }));
}

export function describeStep(step: BugCaseStep, sensitive = true): string {
  // What a person reads on the page first; a test id only when nothing else names it.
  const name = (target: BugCaseTarget) => {
    for (const candidate of target.candidates) {
      if (candidate.kind === 'role' && candidate.name) return `"${candidate.name.slice(0, 60)}"`;
      if (candidate.kind === 'label' || candidate.kind === 'placeholder' || candidate.kind === 'text') {
        return `"${candidate.value.slice(0, 60)}"`;
      }
    }
    const testId = target.candidates.find((candidate) => candidate.kind === 'testId');
    return testId && testId.kind === 'testId' ? testId.value.slice(0, 60) : 'an element';
  };
  switch (step.kind) {
    case 'navigate':
      return `Open ${step.path}`;
    case 'reload':
      return 'Reload the page';
    case 'click':
      return step.count ? `Click ${name(step.target)} ${step.count} times` : `Click ${name(step.target)}`;
    case 'check':
      return `Check ${name(step.target)}`;
    case 'uncheck':
      return `Uncheck ${name(step.target)}`;
    case 'fill':
      if (step.sensitiveRef) return `Type a password into ${name(step.target)}`;
      return `Type "${sensitive ? (step.value ?? '').slice(0, 60) : step.value}" into ${name(step.target)}`;
    case 'select':
      return `Choose ${step.values.map((value) => `"${value.slice(0, 40)}"`).join(', ')} in ${name(step.target)}`;
    case 'press':
      return `Press ${step.key}`;
    case 'dialog':
      return step.action === 'accept' ? 'Accept the dialog' : 'Dismiss the dialog';
  }
}

/** True when the document can be verified: its signature holds a positive check or sits beside a required path. */
export function hasVerifiableSignature(document: BugCaseV1): boolean {
  const byId = new Map(document.assertions.map((assertion) => [assertion.id, assertion]));
  const signature = document.failureSignature.map((entry) => byId.get(entry.assertionId)).filter(Boolean) as BugCaseAssertion[];
  return signature.some(isPositiveAssertion) || document.assertions.some(isRequiredPath);
}
