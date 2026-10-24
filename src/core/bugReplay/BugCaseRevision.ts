import {
  canonicalJson,
  describeBugCaseAssertion,
  describeTarget,
  isDomAssertion,
  type BugCaseAssertion,
  type BugCaseSignatureEntry,
  type BugCaseV1
} from '../../shared/bugCase';
import type {
  BugCaptureCheckTemplate,
  BugCaseCheckView,
  BugExpectationEdit,
  BugExpectationView
} from '../../shared/bugReplay';
import { suggestBugTitle, type BugTitleSeed } from '../../shared/bugReplayClaims';
import {
  answerHolds,
  caseRefusal,
  checkViews,
  elementAssertion,
  elementSignature,
  isWriteMethod,
  statusSignature,
  valueSignature
} from './BugCaseCompiler';
import type { BugRecordedObservation } from './BugReplayRecords';

/**
 * Changing a saved bug's expectations. The person keeps, changes or removes each one; the failure
 * signature is worked out again from what the recording showed, by the compiler's own rules, so a
 * changed version still describes the bug the recording shows. Ids stay as they were: a check
 * keeps its id through every version, and an earlier run's result stays readable against its own.
 */

export const EXPECTATIONS_MOVED = 'The expectations changed after they were shown. Review them again';

type DomAssertion = Extract<BugCaseAssertion, { kind: 'dom.text' | 'dom.value' | 'dom.visible' | 'dom.count' }>;
type RequestAssertion = Extract<BugCaseAssertion, { kind: 'request' }>;

export interface RevisableVersion {
  document: BugCaseV1;
  recorded?: Record<string, BugRecordedObservation>;
}

export interface RevisedCase {
  document: BugCaseV1;
  /** What the recording showed for each kept check. */
  recorded: Record<string, BugRecordedObservation>;
  checks: BugCaseCheckView[];
  /** The edits differ from the version they started from. */
  changed: boolean;
  /** The recording still violates an expectation, so the changed version can be reproduced. */
  reproducible: boolean;
  /** Why the edits cannot be saved. */
  reason?: string;
}

type Revised =
  | { assertion: BugCaseAssertion; changed: false }
  | { assertion: BugCaseAssertion; changed: true; entry?: BugCaseSignatureEntry }
  | { refused: string };

/**
 * The version the edits make: each listed expectation kept or changed, every other one removed.
 * A change is judged against what the recording showed, and the result is refused, with its
 * reason, when the recording would no longer violate anything or the case would not hold.
 */
export function reviseBugCase(base: RevisableVersion, edits: BugExpectationEdit[]): RevisedCase {
  const before = base.document;
  const recorded = base.recorded ?? {};
  const unchanged = (reason?: string): RevisedCase => ({
    document: before,
    recorded,
    checks: checkViews(before),
    changed: false,
    reproducible: !reason,
    ...(reason ? { reason } : {})
  });
  const byId = new Map<string, BugExpectationEdit>();
  for (const edit of edits) {
    if (byId.has(edit.id) || !before.assertions.some((assertion) => assertion.id === edit.id)) return unchanged(EXPECTATIONS_MOVED);
    byId.set(edit.id, edit);
  }

  const previous = new Map(before.failureSignature.map((entry) => [entry.assertionId, entry]));
  const assertions: BugCaseAssertion[] = [];
  const signature: BugCaseSignatureEntry[] = [];
  const kept: Record<string, BugRecordedObservation> = {};
  // When the recording satisfies everything, the element that now matches it says why.
  let matches: string | undefined;
  for (const assertion of before.assertions) {
    const edit = byId.get(assertion.id);
    if (!edit) continue;
    const observed = recorded[assertion.id];
    const revised = reviseOne(assertion, edit, observed, before);
    if ('refused' in revised) return { ...unchanged(revised.refused), changed: true };
    assertions.push(revised.assertion);
    if (observed) kept[assertion.id] = observed;
    const entry = revised.changed ? revised.entry : previous.get(assertion.id);
    if (entry) signature.push(entry);
    else if (revised.changed && isDomAssertion(revised.assertion)) matches ??= `${sentenceStart(describeTarget(revised.assertion.target))} matches the recording`;
  }

  const document: BugCaseV1 = { ...before, assertions, failureSignature: signature };
  const changed = JSON.stringify(assertions) !== JSON.stringify(before.assertions) || JSON.stringify(signature) !== JSON.stringify(before.failureSignature);
  if (!changed) return unchanged();
  const refuse = (reason: string): RevisedCase => ({ document, recorded: kept, checks: checkViews(document), changed: true, reproducible: false, reason });
  if (assertions.length === 0) return refuse('Keep at least one expectation');
  for (const assertion of assertions) {
    if (assertion.kind !== 'request.json' || assertions.some((candidate) => candidate.id === assertion.requestId)) continue;
    return refuse(`The value expectations on ${requestLabel(before, assertion.requestId)} need its status`);
  }
  if (signature.length === 0) return refuse(matches ?? 'No expectation failed in the recording');
  const refused = caseRefusal(document);
  if (refused) return refuse(refused);
  return { document, recorded: kept, checks: checkViews(document), changed: true, reproducible: true };
}

function reviseOne(assertion: BugCaseAssertion, edit: BugExpectationEdit, observed: BugRecordedObservation | undefined, document: BugCaseV1): Revised {
  switch (edit.kind) {
    case 'keep':
      return { assertion, changed: false };
    case 'element': {
      if (!isDomAssertion(assertion)) return { refused: EXPECTATIONS_MOVED };
      const facts = observed?.kind === 'element' ? observed : undefined;
      const next = elementAssertion(edit, facts?.field ?? assertion.kind === 'dom.value', assertion.target, assertion.id);
      const subject = describeTarget(assertion.target);
      if (!next) return { refused: `Write what ${subject === 'The element' ? 'it' : subject} should ${edit.template === 'contains' ? 'contain' : 'read'}` };
      // Also after reload is never part of the signature: the recorded failure stays as it was.
      if (sameCheck(next as DomAssertion, assertion)) return { assertion: next, changed: false };
      if (!facts) return { refused: `Record the bug again to change the expectation on ${subject}` };
      return { assertion: next, changed: true, entry: elementSignature(next, facts) };
    }
    case 'status': {
      if (!isStatusCheck(assertion)) return { refused: EXPECTATIONS_MOVED };
      if (assertion.status === edit.check) return { assertion, changed: false };
      if (observed?.kind !== 'requests') return { refused: `Record the bug again to change the expectation on ${assertion.method} ${assertion.pathTemplate}` };
      const next: RequestAssertion = { ...assertion, status: edit.check };
      return { assertion: next, changed: true, entry: statusSignature(next, observed) };
    }
    case 'value': {
      if (assertion.kind !== 'request.json') return { refused: EXPECTATIONS_MOVED };
      const label = requestLabel(document, assertion.requestId);
      let value: unknown;
      try {
        value = JSON.parse(edit.expected);
      } catch {
        return { refused: `The expected value for ${label} is not valid` };
      }
      const equals = canonicalJson(value);
      if (equals === assertion.equals) return { assertion, changed: false };
      if (observed?.kind !== 'json') return { refused: `Record the bug again to change the expectation on ${label}` };
      const next = { ...assertion, equals };
      return { assertion: next, changed: true, entry: valueSignature(next, observed.values) };
    }
  }
}

/** Two element checks that compare the same thing, whatever they say about after reload. */
function sameCheck(left: DomAssertion, right: DomAssertion): boolean {
  switch (left.kind) {
    case 'dom.text':
      return right.kind === 'dom.text' && left.op === right.op && left.value === right.value;
    case 'dom.value':
      return right.kind === 'dom.value' && left.value === right.value;
    case 'dom.visible':
      return right.kind === 'dom.visible' && left.expected === right.expected;
    case 'dom.count':
      return right.kind === 'dom.count' && left.value === right.value;
  }
}

/** A request the action must send and the app must answer: the status the editor offers. */
function isStatusCheck(assertion: BugCaseAssertion): assertion is RequestAssertion & { status: 'success' | 'answered' } {
  return assertion.kind === 'request' && assertion.count.op === 'atLeast' && (assertion.status === 'success' || assertion.status === 'answered');
}

function isSentOnce(assertion: BugCaseAssertion): assertion is RequestAssertion {
  return assertion.kind === 'request' && assertion.count.op === 'exactly' && assertion.count.n === 1 && assertion.status === undefined;
}

function requestLabel(document: BugCaseV1, requestId: string): string {
  const anchor = document.assertions.find((candidate) => candidate.id === requestId);
  return anchor?.kind === 'request' ? `${anchor.method} ${anchor.pathTemplate}` : 'the request';
}

/** What an element check asks, as the capture panel's controls say it. */
export function templateOf(assertion: DomAssertion): { template: BugCaptureCheckTemplate; expected?: string; count?: number } {
  switch (assertion.kind) {
    case 'dom.text':
      return { template: assertion.op, expected: assertion.value };
    case 'dom.value':
      return { template: 'equals', expected: assertion.value };
    case 'dom.visible':
      return { template: assertion.expected ? 'visible' : 'hidden' };
    case 'dom.count':
      return { template: 'count', count: assertion.value };
  }
}

/**
 * What changed between two versions, in one line: the one changed expectation as it reads now, the
 * one removed as it read, or how many changed and were removed.
 */
export function describeRevision(before: BugCaseV1, after: BugCaseV1): string {
  const now = new Map(after.assertions.map((assertion) => [assertion.id, assertion]));
  const changed = before.assertions.filter((assertion) => now.has(assertion.id) && JSON.stringify(now.get(assertion.id)) !== JSON.stringify(assertion));
  const removed = before.assertions.filter((assertion) => !now.has(assertion.id));
  if (changed.length === 1 && removed.length === 0) return describeBugCaseAssertion(now.get(changed[0].id)!, after);
  if (removed.length === 1 && changed.length === 0) return `Removed: ${describeBugCaseAssertion(removed[0], before)}`;
  return [changed.length ? `${changed.length} changed` : '', removed.length ? `${removed.length} removed` : ''].filter(Boolean).join(', ');
}

/**
 * The bug's name after a change, when it still is the name its first element expectation
 * suggested: it states what should be true, so it follows the expectation. A name the person
 * wrote stays.
 */
export function followedTitle(title: string, before: RevisableVersion, after: RevisableVersion): string | undefined {
  const seed = (version: RevisableVersion): BugTitleSeed | undefined => {
    const first = version.document.assertions.find(isDomAssertion);
    const facts = first ? version.recorded?.[first.id] : undefined;
    if (!first || facts?.kind !== 'element') return undefined;
    return { label: facts.label, ...templateOf(first), shown: facts.value ?? facts.text };
  };
  const was = seed(before);
  if (!was || suggestBugTitle(was) !== title) return undefined;
  const next = suggestBugTitle(seed(after));
  return next && next !== title ? next : undefined;
}

/**
 * The expectations as the editor lists them, in the case's order: one row per element, one per
 * request (its status and Sent once together), one per value and one for the page error, each
 * with what the recording showed. Every check has a row, so nothing is removed unseen.
 */
export function expectationViews(document: BugCaseV1, recorded: Record<string, BugRecordedObservation> | undefined, mask: (text: string) => string): BugExpectationView[] {
  const rows: BugExpectationView[] = [];
  const requests = new Map<string, Extract<BugExpectationView, { kind: 'request' }>>();
  const requestRow = (assertion: RequestAssertion) => {
    const key = `${assertion.method} ${assertion.origin} ${assertion.pathTemplate}?${assertion.queryKeys.join('&')}`;
    let row = requests.get(key);
    if (!row) {
      row = { kind: 'request', name: `${assertion.method} ${assertion.pathTemplate}`, failed: false, write: isWriteMethod(assertion.method), valueIds: [] };
      requests.set(key, row);
      rows.push(row);
    }
    return row;
  };
  for (const assertion of document.assertions) {
    const observed = recorded?.[assertion.id];
    if (isDomAssertion(assertion)) {
      const facts = observed?.kind === 'element' ? observed : undefined;
      rows.push({
        kind: 'element',
        id: assertion.id,
        name: facts?.label ?? describeTarget(assertion.target),
        ...(facts ? { recorded: mask(shownWords(facts)) } : {}),
        ...templateOf(assertion),
        alsoAfterReload: assertion.alsoAfterReload,
        field: facts?.field ?? assertion.kind === 'dom.value'
      });
    } else if (isStatusCheck(assertion) || isSentOnce(assertion)) {
      const row = requestRow(assertion);
      if (isStatusCheck(assertion)) row.status = { id: assertion.id, check: assertion.status };
      else row.sentOnceId = assertion.id;
      // The status check counts every request the action sent this way; it says what the recording got.
      if (observed?.kind === 'requests' && (!row.recorded || isStatusCheck(assertion))) {
        row.recorded = answersWords(observed);
        row.failed = observed.count === 0 || observed.answers.some((answer) => !answerHolds('success', answer));
      }
    } else if (assertion.kind === 'request.json') {
      const anchor = document.assertions.find((candidate) => candidate.id === assertion.requestId);
      if (anchor?.kind === 'request') requestRow(anchor).valueIds.push(assertion.id);
      const first = observed?.kind === 'json' ? observed.values[0] : undefined;
      rows.push({
        kind: 'value',
        id: assertion.id,
        name: `${anchor?.kind === 'request' ? `${anchor.method} ${anchor.pathTemplate}` : 'The request'} ${assertion.side === 'request' ? 'sends' : 'returns'} ${assertion.pointer.slice(1).replace(/\//g, '.') || 'body'}`,
        ...(first === undefined ? {} : { recorded: mask(first === null ? 'Had no value' : `Was ${first}`) }),
        expected: assertion.equals
      });
    } else if (assertion.kind === 'console.noUncaughtError') {
      const raised = observed?.kind === 'pageError' ? observed.raised : document.failureSignature.some((entry) => entry.assertionId === assertion.id);
      rows.push({ kind: 'pageError', id: assertion.id, recorded: raised ? 'The last step raised an error' : 'The last step raised no error' });
    } else {
      rows.push({ kind: 'other', id: assertion.id, statement: describeBugCaseAssertion(assertion, document) });
    }
  }
  return rows;
}

/** What a picked element showed, as the capture panel said it. */
function shownWords(facts: Extract<BugRecordedObservation, { kind: 'element' }>): string {
  if (facts.value !== undefined) return `Held "${facts.value}"`;
  if (facts.text) return `Showed "${facts.text}"`;
  return facts.visible ? 'Visible, no text' : 'Not visible';
}

/** How the recording's requests were answered: the first that failed, or the first answer, and how many there were. */
function answersWords(observed: Extract<BugRecordedObservation, { kind: 'requests' }>): string {
  if (observed.count === 0) return 'Not sent';
  const shown = observed.answers.find((answer) => !answerHolds('success', answer)) ?? observed.answers[0];
  const words = shown === undefined || shown === 'no-response' ? 'Got no response' : `Returned ${shown}`;
  return observed.count > 1 ? `${words} ×${observed.count}` : words;
}

function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
