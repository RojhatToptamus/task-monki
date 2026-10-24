import {
  describeTarget,
  isAbsenceAssertion,
  isDomAssertion,
  normalizeVisibleText,
  pathMatchesTemplate,
  type BugCaseAssertion,
  type BugCaseCaptured,
  type BugCaseSignatureEntry,
  type BugCaseTargetCandidate,
  type BugCaseV1
} from '../../shared/bugCase';
import type {
  BugReplayAssertionObservation,
  BugReplayRunFailure,
  BugReplayRunOutcome,
  BugReplayRunRecord
} from '../../shared/bugReplay';
import type {
  BugReplayDomObservation,
  BugReplayFrame,
  BugReplayObservation,
  BugReplayRequestFact
} from './runner/protocol';
import { serviceStoppedSentence } from '../../shared/bugReplayClaims';
import { statusHolds } from './BugCaseCompiler';

/**
 * Pure verdict rules. The runner reports what it saw; these functions decide what a run means
 * for the bug. Nothing here reads files, clocks or the network, so every rule is testable.
 */

export interface RunEnvironmentSignals {
  /** A service or worker of the environment stopped after it was ready. */
  serviceStopped?: string;
  /** Tracked files of the frozen copy changed while the app ran. */
  sourceChanged?: string[];
  /** For a candidate: the weakest candidate each check's element needed on the recorded code. */
  baselineLocators?: Record<string, number>;
}

export interface EvaluatedRun {
  /** BLOCKED: the run cannot say anything about the fix, and says why. */
  outcome: Extract<BugReplayRunOutcome, 'REPRODUCED' | 'NOT_REPRODUCED' | 'PASSED' | 'FAILED' | 'BLOCKED'>;
  failure?: BugReplayRunFailure;
  observations: BugReplayAssertionObservation[];
  facts: string[];
  /** What each signature check showed, for comparing the two runs of a qualification. */
  signatureObserved: Record<string, string>;
}

interface IndexedFrames {
  steps: Extract<BugReplayFrame, { type: 'step' }>[];
  main: Map<string, BugReplayObservation>;
  afterReload: Map<string, BugReplayDomObservation>;
  signals: Extract<BugReplayFrame, { type: 'signal' }>[];
  requests: BugReplayRequestFact[];
  windows: Extract<BugReplayFrame, { type: 'window' }>[];
  /** Where each checked element sat in the final screenshot. */
  marks: Map<string, { x: number; y: number; width: number; height: number }>;
}

export function evaluateRun(
  kind: 'BASELINE' | 'CANDIDATE',
  document: BugCaseV1,
  frames: BugReplayFrame[],
  environment: RunEnvironmentSignals = {}
): EvaluatedRun {
  const indexed = indexFrames(frames);
  const facts = runFacts(indexed, document);
  const failedStep = indexed.steps.find((step) => step.status === 'failed');
  const signature = new Map(document.failureSignature.map((entry) => [entry.assertionId, entry]));
  const observations = document.assertions.map((assertion) => observationView(assertion, indexed, document));
  const signatureObserved: Record<string, string> = {};
  for (const assertion of document.assertions) {
    if (!signature.has(assertion.id)) continue;
    const observed = describeObserved(assertion, indexed.main.get(assertion.id), document);
    if (observed !== undefined) signatureObserved[assertion.id] = observed;
  }

  const appFailure = appAttributableFailure(kind, document, indexed, environment, signature);

  if (kind === 'CANDIDATE') {
    if (failedStep) {
      return { outcome: 'FAILED', failure: stepFailure(failedStep), observations, facts, signatureObserved };
    }
    if (appFailure) return { outcome: 'FAILED', failure: appFailure, observations, facts, signatureObserved };
    // A check that found its element a weaker way than on the recorded code may be reading
    // another element: neither a pass nor a failure is about the recorded one.
    const drift = locatorDrift(document, indexed, environment.baselineLocators);
    if (drift) return { outcome: 'BLOCKED', failure: drift, observations, facts, signatureObserved };
    for (const assertion of document.assertions) {
      const verdict = holds(assertion, indexed.main.get(assertion.id), document);
      if (!verdict.holds) {
        return {
          outcome: 'FAILED',
          failure: { reason: 'CHECK_FAILED', detail: verdict.detail, assertionId: assertion.id },
          observations,
          facts,
          signatureObserved
        };
      }
      if (isDomAssertion(assertion) && assertion.alsoAfterReload) {
        const after = indexed.afterReload.get(assertion.id);
        if (!after || !(after.matched && after.held)) {
          return {
            outcome: 'FAILED',
            failure: {
              reason: 'CHECK_FAILED',
              detail: `After: ${afterReloadText(assertion, after)} after reload`,
              assertionId: assertion.id
            },
            observations,
            facts,
            signatureObserved
          };
        }
      }
    }
    return { outcome: 'PASSED', observations, facts, signatureObserved };
  }

  // A baseline run reproduces when it fails exactly as the recording did.
  if (failedStep) {
    return { outcome: 'NOT_REPRODUCED', failure: stepFailure(failedStep), observations, facts, signatureObserved };
  }
  if (appFailure) return { outcome: 'NOT_REPRODUCED', failure: appFailure, observations, facts, signatureObserved };
  for (const assertion of document.assertions) {
    const entry = signature.get(assertion.id);
    const observation = indexed.main.get(assertion.id);
    if (entry) {
      if (!showsSignature(entry, assertion, observation, document)) {
        const held = holds(assertion, observation, document).holds;
        return {
          outcome: 'NOT_REPRODUCED',
          failure: {
            reason: held ? 'NOT_REPRODUCED' : 'SIGNATURE_MISMATCH',
            detail: held
              ? `The clean copy showed the expected result: ${describeObserved(assertion, observation, document) ?? 'it passed'}`
              : `Not reproduced: ${describeObserved(assertion, observation, document) ?? 'it failed differently'}${
                  entry.captured ? `, recorded ${capturedText(entry.captured)}` : ''
                }`,
            assertionId: assertion.id
          },
          observations,
          facts,
          signatureObserved
        };
      }
      continue;
    }
    const verdict = holds(assertion, observation, document);
    if (!verdict.holds) {
      return {
        outcome: 'NOT_REPRODUCED',
        failure: { reason: 'CHECK_FAILED', detail: `The clean copy failed another check: ${verdict.detail}`, assertionId: assertion.id },
        observations,
        facts,
        signatureObserved
      };
    }
  }
  for (const assertion of document.assertions) {
    if (!isDomAssertion(assertion) || !assertion.alsoAfterReload) continue;
    const before = indexed.main.get(assertion.id) as BugReplayDomObservation | undefined;
    const after = indexed.afterReload.get(assertion.id);
    if (isAbsenceAssertion(assertion)) continue;
    if (!after || !after.found) {
      return {
        outcome: 'NOT_REPRODUCED',
        failure: {
          reason: 'RELOAD_TARGET_MISSING',
          detail: `${sentenceStart(targetWord(assertion))} isn't shown after reload. Turn off Also after reload.`,
          assertionId: assertion.id
        },
        observations,
        facts,
        signatureObserved
      };
    }
    const sameAsBefore = domValue(after) === domValue(before);
    if (!sameAsBefore && !after.matched) {
      return {
        outcome: 'NOT_REPRODUCED',
        failure: {
          reason: 'RELOAD_VALUE_CHANGED',
          detail: `After reload it shows ${quote(domValue(after))}, not ${quote(domValue(before))}. Turn off Also after reload, or keep browser storage on reload.`,
          assertionId: assertion.id
        },
        observations,
        facts,
        signatureObserved
      };
    }
  }
  return { outcome: 'REPRODUCED', observations, facts, signatureObserved };
}

/** Does the check hold as the person expects it to? */
export function holds(
  assertion: BugCaseAssertion,
  observation: BugReplayObservation | undefined,
  document: BugCaseV1
): { holds: boolean; detail: string } {
  const observed = describeObserved(assertion, observation, document);
  switch (assertion.kind) {
    case 'dom.text':
    case 'dom.value':
    case 'dom.visible':
    case 'dom.count': {
      const dom = asDom(observation);
      const ok = Boolean(dom && dom.matched && dom.held);
      if (ok) return { holds: true, detail: '' };
      if (dom && dom.matched && !dom.held) {
        return { holds: false, detail: `${sentenceStart(targetWord(assertion))} changed during the check${dom.firstMatchText ? ` (it first showed ${quote(dom.firstMatchText)})` : ''}` };
      }
      return { holds: false, detail: `After: ${observed ?? `${targetWord(assertion)} was not found`}` };
    }
    case 'console.noUncaughtError':
      return observation?.kind === 'console' && observation.errors.length === 0
        ? { holds: true, detail: '' }
        : { holds: false, detail: `After: the page raised an error${observation?.kind === 'console' && observation.errors[0] ? ` (${observation.errors[0].slice(0, 120)})` : ''}` };
    case 'request': {
      const matches = observation?.kind === 'request' ? observation.matches : [];
      const label = `${assertion.method} ${assertion.pathTemplate}`;
      if (assertion.count.op === 'exactly') {
        return matches.length === assertion.count.n
          ? { holds: true, detail: '' }
          : { holds: false, detail: `After: ${label} was sent ${times(matches.length)}` };
      }
      if (matches.length < assertion.count.n) return { holds: false, detail: `After: ${label} was not sent` };
      const bad = matches.find((match) => !statusHolds(assertion.status, factOutcome(match)));
      return bad
        ? { holds: false, detail: `After: ${label} ${bad.gateway || bad.outcome !== 'response' ? 'got no response' : `returned ${bad.status}`}` }
        : { holds: true, detail: '' };
    }
    case 'request.json': {
      const matches = observation?.kind === 'request' ? observation.matches : [];
      const anchor = document.assertions.find((candidate) => candidate.id === assertion.requestId);
      const label = anchor && anchor.kind === 'request' ? `${anchor.method} ${anchor.pathTemplate}` : 'The request';
      const field = assertion.pointer ? assertion.pointer.slice(1).replace(/\//g, '.') : 'body';
      if (matches.length === 0) return { holds: false, detail: `After: ${label} was not sent` };
      for (const match of matches) {
        const values = assertion.side === 'request' ? match.requestValues : match.responseValues;
        const value = values?.[assertion.pointer];
        if (assertion.side === 'request') {
          if (value === undefined || value === null) continue;
          if (value !== assertion.equals) return { holds: false, detail: `After: ${label} sent ${field} = ${value}` };
        } else if (value === undefined || value === null) {
          return { holds: false, detail: `After: ${label} returned no ${field}` };
        } else if (value !== assertion.equals) {
          return { holds: false, detail: `After: ${label} returned ${field} = ${value}` };
        }
      }
      return { holds: true, detail: '' };
    }
  }
}

/** Does the run show exactly what the recording showed for this signature check? */
function showsSignature(
  entry: BugCaseSignatureEntry,
  assertion: BugCaseAssertion,
  observation: BugReplayObservation | undefined,
  document: BugCaseV1
): boolean {
  const failsExpectation = !holds(assertion, observation, document).holds;
  if (entry.mode === 'ANY_MISMATCH' || !entry.captured) return failsExpectation;
  const captured = entry.captured;
  const dom = asDom(observation);
  switch (captured.kind) {
    case 'text':
      return failsExpectation && Boolean(dom?.text !== undefined && normalizeVisibleText(dom.text).includes(captured.token));
    case 'value':
      return failsExpectation && dom?.value === captured.value;
    case 'visible':
      return Boolean(dom) && dom!.visible === captured.value && failsExpectation;
    case 'count':
      return Boolean(dom) && dom!.count === captured.value && failsExpectation;
    case 'status': {
      if (observation?.kind !== 'request') return false;
      return observation.matches.some((match) => {
        const answered = match.outcome === 'response' && !match.gateway && match.status !== undefined;
        return captured.value === 'no-response' ? !answered : answered && match.status === captured.value;
      });
    }
    case 'requestCount':
      return observation?.kind === 'request' && observation.matches.length === captured.value;
    case 'json': {
      if (observation?.kind !== 'request' || assertion.kind !== 'request.json') return false;
      return observation.matches.some((match) => {
        const values = assertion.side === 'request' ? match.requestValues : match.responseValues;
        const value = values?.[assertion.pointer] ?? null;
        return value === captured.value;
      });
    }
  }
}

/**
 * Signals that the app, not Task Monki, failed after it was ready. The exception is an
 * unanswered request the recording also saw unanswered: that is the bug itself.
 */
function appAttributableFailure(
  kind: 'BASELINE' | 'CANDIDATE',
  document: BugCaseV1,
  indexed: IndexedFrames,
  environment: RunEnvironmentSignals,
  signature: Map<string, BugCaseSignatureEntry>
): BugReplayRunFailure | undefined {
  if (environment.sourceChanged && environment.sourceChanged.length > 0) {
    return { reason: 'SOURCE_CHANGED', detail: `The app changed its own files while it ran (${environment.sourceChanged.slice(0, 3).join(', ')})` };
  }
  if (environment.serviceStopped) {
    return { reason: 'APP_FAILED', detail: serviceStoppedSentence(environment.serviceStopped) };
  }
  const crash = indexed.signals.find((signal) => signal.signal === 'renderer-crash');
  if (crash) return { reason: 'APP_FAILED', detail: 'The page crashed' };
  const recordedNoResponse = new Set<string>();
  if (kind === 'BASELINE') {
    for (const assertion of document.assertions) {
      const entry = signature.get(assertion.id);
      if (assertion.kind === 'request' && entry?.captured?.kind === 'status' && entry.captured.value === 'no-response') {
        recordedNoResponse.add(`${assertion.method} ${assertion.pathTemplate}`);
      }
    }
  }
  const unanswered = indexed.requests.filter(
    (request) =>
      request.role !== undefined &&
      ['fetch', 'xhr', 'document'].includes(request.resourceType) &&
      (request.gateway || (request.outcome === 'pending' && (request.pendingMs ?? 0) >= 8_000))
  );
  for (const request of unanswered) {
    const known = [...recordedNoResponse].some((key) => {
      const [method, template] = key.split(' ');
      return method === request.method && pathMatchesTemplate(request.path, template);
    });
    if (known) continue;
    return {
      reason: 'APP_FAILED',
      detail: `The app stopped answering: ${request.method} ${request.path} ${request.gateway ? 'got no response' : 'had no response after 8 s'}`
    };
  }
  return undefined;
}

function stepFailure(step: Extract<BugReplayFrame, { type: 'step' }>): BugReplayRunFailure {
  return {
    reason: step.failure === 'page-crashed' ? 'APP_FAILED' : 'STEP_FAILED',
    detail: step.detail ?? `Could not complete step ${step.index + 1}`,
    stepIndex: step.index
  };
}

function indexFrames(frames: BugReplayFrame[]): IndexedFrames {
  const indexed: IndexedFrames = { steps: [], main: new Map(), afterReload: new Map(), signals: [], requests: [], windows: [], marks: new Map() };
  for (const frame of frames) {
    switch (frame.type) {
      case 'step':
        indexed.steps.push(frame);
        break;
      case 'assertion':
        if (frame.phase === 'main') indexed.main.set(frame.assertionId, frame.observation);
        else if (frame.observation.kind === 'dom') indexed.afterReload.set(frame.assertionId, frame.observation);
        break;
      case 'signal':
        indexed.signals.push(frame);
        break;
      case 'requests':
        indexed.requests.push(...frame.requests);
        break;
      case 'window':
        indexed.windows.push(frame);
        break;
      case 'screenshot':
        if (frame.purpose === 'final') for (const mark of frame.marks ?? []) indexed.marks.set(mark.assertionId, mark.box);
        break;
      default:
        break;
    }
  }
  return indexed;
}

/** The first check whose element was found by a later candidate than the recorded runs needed. */
function locatorDrift(document: BugCaseV1, indexed: IndexedFrames, baseline: Record<string, number> | undefined): BugReplayRunFailure | undefined {
  if (!baseline) return undefined;
  for (const assertion of document.assertions) {
    if (!isDomAssertion(assertion)) continue;
    const recorded = baseline[assertion.id];
    const dom = asDom(indexed.main.get(assertion.id));
    if (recorded === undefined || !dom?.found || dom.candidateIndex === undefined || dom.candidateIndex <= recorded) continue;
    const used = assertion.target.candidates[dom.candidateIndex];
    const before = assertion.target.candidates[recorded];
    return {
      reason: 'TARGET_CHANGED',
      detail: `Couldn't verify: ${targetWord(assertion)} was found by ${locatorWords(used)}, not by ${locatorWords(before)} as on the recorded code`,
      assertionId: assertion.id
    };
  }
  return undefined;
}

function locatorWords(candidate: BugCaseTargetCandidate | undefined): string {
  switch (candidate?.kind) {
    case 'testId':
      return 'its test id';
    case 'role':
      return 'its role and name';
    case 'label':
      return 'its label';
    case 'placeholder':
      return 'its placeholder';
    case 'text':
      return 'its text';
    default:
      return 'its position on the page';
  }
}

function runFacts(indexed: IndexedFrames, document: BugCaseV1): string[] {
  const facts = new Set<string>();
  for (const signal of indexed.signals) {
    if (signal.signal === 'network-never-quiet') facts.add('The network never went quiet; checks ran to the time limit.');
    else if (signal.signal === 'retried-navigation') facts.add(signal.detail);
    else if (signal.signal === 'page-navigation') facts.add(signal.detail);
    else if (signal.signal === 'unexpected-dialog') facts.add(signal.detail);
  }
  const fallbacks = indexed.steps.filter((step) => step.status === 'done' && (step.candidateIndex ?? 0) > 0);
  for (const step of fallbacks.slice(0, 5)) {
    facts.add(`Step ${step.index + 1} matched by fallback locator ${(step.candidateIndex ?? 0) + 1}`);
  }
  // Checks found another way than their first candidate: the reviewer should know which element was read.
  for (const assertion of document.assertions) {
    if (!isDomAssertion(assertion)) continue;
    const dom = asDom(indexed.main.get(assertion.id));
    if (!dom?.found || !dom.candidateIndex) continue;
    facts.add(`${sentenceStart(targetWord(assertion))} found by ${locatorWords(assertion.target.candidates[dom.candidateIndex])}`);
  }
  const blocked = new Map<string, number>();
  for (const request of indexed.requests) {
    if (request.outcome === 'blocked' && request.host) blocked.set(request.host, (blocked.get(request.host) ?? 0) + 1);
  }
  for (const [host, count] of [...blocked.entries()].slice(0, 5)) facts.add(`Blocked ${times(count, 'request')} to ${host}`);
  return [...facts];
}

function observationView(assertion: BugCaseAssertion, indexed: IndexedFrames, document: BugCaseV1): BugReplayAssertionObservation {
  const observation = indexed.main.get(assertion.id);
  const view: BugReplayAssertionObservation = {
    assertionId: assertion.id,
    passed: holds(assertion, observation, document).holds
  };
  const dom = asDom(observation);
  if (dom?.found && dom.candidateIndex !== undefined) view.locator = dom.candidateIndex;
  const observed = describeObserved(assertion, observation, document);
  if (observed !== undefined) view.observed = observed;
  const value = observedValue(assertion, observation);
  if (value !== undefined) view.value = value;
  const box = indexed.marks.get(assertion.id);
  if (box) view.box = { ...box };
  if (isDomAssertion(assertion) && assertion.alsoAfterReload) {
    const after = indexed.afterReload.get(assertion.id);
    if (after) {
      const afterValue = observedValue(assertion, after);
      view.afterReload = {
        passed: after.matched && after.held,
        ...(domValue(after) !== undefined ? { observed: afterReloadText(assertion, after) } : {}),
        ...(afterValue !== undefined ? { value: afterValue } : {})
      };
    }
  }
  return view;
}

/** What a run observed for a check, as a value alone for a results column: '"$40.00"', '200', 'Not shown'. */
export function observedValue(assertion: BugCaseAssertion, observation: BugReplayObservation | undefined): string | undefined {
  switch (assertion.kind) {
    case 'dom.text': {
      const dom = asDom(observation);
      return dom?.found ? quote(clipValue(dom.text ?? '')) : 'Not shown';
    }
    case 'dom.value': {
      const dom = asDom(observation);
      return dom?.found ? quote(clipValue(dom.value ?? '')) : 'Not shown';
    }
    case 'dom.visible': {
      const dom = asDom(observation);
      return dom?.visible ? 'Visible' : 'Not visible';
    }
    case 'dom.count': {
      const dom = asDom(observation);
      return sentenceStart(times(dom?.count ?? 0));
    }
    case 'console.noUncaughtError':
      if (observation?.kind !== 'console') return undefined;
      return observation.errors.length > 0 ? clipValue(observation.errors[0].split('\n')[0]) : 'No error';
    case 'request': {
      if (observation?.kind !== 'request') return undefined;
      if (observation.matches.length === 0) return 'Not sent';
      if (assertion.count.op === 'exactly') return `Sent ${times(observation.matches.length)}`;
      const first = observation.matches.find((match) => !statusHolds(assertion.status, factOutcome(match))) ?? observation.matches[0];
      return first.gateway || first.outcome !== 'response' ? 'No response' : String(first.status);
    }
    case 'request.json': {
      if (observation?.kind !== 'request') return undefined;
      const first = observation.matches[0];
      if (!first) return 'Not sent';
      const values = assertion.side === 'request' ? first.requestValues : first.responseValues;
      const value = values?.[assertion.pointer];
      return value === undefined || value === null ? 'No value' : clipValue(value);
    }
  }
}

function clipValue(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** What the run showed for a check, in words: "total showed $40.00". */
export function describeObserved(
  assertion: BugCaseAssertion,
  observation: BugReplayObservation | undefined,
  document: BugCaseV1
): string | undefined {
  const subject = targetWord(assertion);
  switch (assertion.kind) {
    case 'dom.text': {
      const dom = asDom(observation);
      if (!dom?.found) return `${subject} was not shown`;
      return `${subject} showed ${quote(dom.text ?? '')}`;
    }
    case 'dom.value': {
      const dom = asDom(observation);
      if (!dom?.found) return `${subject} was not shown`;
      return `${subject} held ${quote(dom.value ?? '')}`;
    }
    case 'dom.visible': {
      const dom = asDom(observation);
      return dom?.visible ? `${subject} was visible` : `${subject} was not visible`;
    }
    case 'dom.count': {
      const dom = asDom(observation);
      return `${subject} appeared ${times(dom?.count ?? 0)}`;
    }
    case 'console.noUncaughtError':
      return observation?.kind === 'console' && observation.errors.length > 0 ? 'the page raised an error' : 'the page raised no error';
    case 'request': {
      if (observation?.kind !== 'request') return undefined;
      const label = `${assertion.method} ${assertion.pathTemplate}`;
      if (observation.matches.length === 0) return `${label} was not sent`;
      if (assertion.count.op === 'exactly') return `${label} was sent ${times(observation.matches.length)}`;
      const first = observation.matches.find((match) => !statusHolds(assertion.status, factOutcome(match))) ?? observation.matches[0];
      return first.gateway || first.outcome !== 'response' ? `${label} got no response` : `${label} returned ${first.status}`;
    }
    case 'request.json': {
      if (observation?.kind !== 'request') return undefined;
      const anchor = document.assertions.find((candidate) => candidate.id === assertion.requestId);
      const label = anchor && anchor.kind === 'request' ? `${anchor.method} ${anchor.pathTemplate}` : 'the request';
      const field = assertion.pointer ? assertion.pointer.slice(1).replace(/\//g, '.') : 'body';
      const first = observation.matches[0];
      if (!first) return `${label} was not sent`;
      const values = assertion.side === 'request' ? first.requestValues : first.responseValues;
      const value = values?.[assertion.pointer];
      if (value === undefined || value === null) return `${label} ${assertion.side === 'request' ? 'sent' : 'returned'} no ${field}`;
      return `${label} ${assertion.side === 'request' ? 'sent' : 'returned'} ${field} = ${value}`;
    }
  }
}

function afterReloadText(assertion: BugCaseAssertion, after: BugReplayDomObservation | undefined): string {
  const subject = targetWord(assertion);
  if (!after?.found) return `${subject} was not shown`;
  if (assertion.kind === 'dom.value') return `${subject} held ${quote(after.value ?? '')}`;
  if (assertion.kind === 'dom.text') return `${subject} showed ${quote(after.text ?? '')}`;
  if (assertion.kind === 'dom.count') return `${subject} appeared ${times(after.count)}`;
  return after.visible ? `${subject} was visible` : `${subject} was not visible`;
}

function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The element a check reads, named by the one rule statements use, for the middle of a sentence. */
function targetWord(assertion: BugCaseAssertion): string {
  if (!isDomAssertion(assertion)) return 'the request';
  const name = describeTarget(assertion.target);
  return name === 'The element' ? 'the element' : name;
}

function domValue(observation: BugReplayDomObservation | undefined): string | undefined {
  if (!observation?.found) return undefined;
  return observation.text ?? observation.value ?? (observation.visible ? 'visible' : 'hidden');
}

function asDom(observation: BugReplayObservation | undefined): BugReplayDomObservation | undefined {
  return observation?.kind === 'dom' ? observation : undefined;
}

function factOutcome(fact: BugReplayRequestFact): { outcome: 'response' | 'failed' | 'blocked' | 'pending'; gateway?: boolean; status?: number } {
  return { outcome: fact.outcome, ...(fact.gateway ? { gateway: true } : {}), ...(fact.status === undefined ? {} : { status: fact.status }) };
}

/** What the recording showed for a check it violated, as a value alone: '"$40.00"', 'No response'. */
export function capturedValue(captured: BugCaseCaptured): string {
  return sentenceStart(capturedText(captured));
}

function capturedText(captured: BugCaseCaptured): string {
  switch (captured.kind) {
    case 'text':
      return quote(captured.token);
    case 'value':
      return quote(captured.value);
    case 'visible':
      return captured.value ? 'visible' : 'not visible';
    case 'count':
      return times(captured.value);
    case 'status':
      return captured.value === 'no-response' ? 'no response' : String(captured.value);
    case 'requestCount':
      return `sent ${times(captured.value)}`;
    case 'json':
      return captured.value ?? 'no value';
  }
}

function quote(value: string | undefined): string {
  const text = (value ?? '').slice(0, 120);
  return `"${text}"`;
}

function times(count: number, noun?: string): string {
  if (noun) return `${count} ${noun}${count === 1 ? '' : 's'}`;
  return count === 1 ? 'once' : `${count} times`;
}

export type QualificationOutcome =
  | { state: 'PENDING'; matched: number; total: number }
  | { state: 'REPRODUCED'; matched: number; total: number }
  | { state: 'NOT_REPRODUCED'; matched: number; total: number; detail: string; volatile?: boolean }
  | { state: 'FLAKY'; matched: number; total: number; detail: string }
  | { state: 'BLOCKED'; matched: number; total: number; detail: string };

/**
 * A qualification needs two counted runs. Two that reproduce identically give Bug reproduced;
 * one gives Flaky; none gives Not reproduced. An infrastructure outcome gets one replacement.
 */
export function qualificationOutcome(runs: Pick<BugReplayRunRecord, 'outcome' | 'counted' | 'failure' | 'state'>[], signatureObserved: Array<Record<string, string> | undefined>, volatileIds: Set<string>): QualificationOutcome {
  const counted = runs.filter((run) => run.counted);
  const matched = counted.filter((run) => run.outcome === 'REPRODUCED').length;
  const total = 2;
  const blocking = runs.filter((run) => run.state === 'SETTLED' && !run.counted);
  const terminalBlock = blocking.find((run) => run.outcome === 'BLOCKED' || run.outcome === 'ENV_FILES_CHANGED' || run.outcome === 'CANCELED');
  if (terminalBlock) {
    return { state: 'BLOCKED', matched, total, detail: terminalBlock.failure?.detail ?? 'The clean copy could not run.' };
  }
  const infrastructure = blocking.filter((run) => run.outcome === 'ENVIRONMENT_FAILED');
  if (infrastructure.length >= 2) {
    return { state: 'BLOCKED', matched, total, detail: infrastructure[infrastructure.length - 1].failure?.detail ?? 'The clean copy did not start.' };
  }
  if (counted.length < 2) return { state: 'PENDING', matched, total };
  const firstTwo = counted.slice(0, 2);
  const reproduced = firstTwo.filter((run) => run.outcome === 'REPRODUCED').length;
  if (reproduced === 2) {
    const [left, right] = signatureObserved;
    for (const id of volatileIds) {
      if (left?.[id] !== undefined && right?.[id] !== undefined && left[id] !== right[id]) {
        return {
          state: 'NOT_REPRODUCED',
          matched: 2,
          total,
          detail: `Not reproduced: the checked text changes between runs (${left[id].slice(0, 60)}, then ${right[id].slice(0, 60)})`,
          volatile: true
        };
      }
    }
    return { state: 'REPRODUCED', matched: 2, total };
  }
  if (reproduced === 1) {
    return { state: 'FLAKY', matched: 1, total, detail: 'Flaky. Before: failed 1 of 2' };
  }
  const first = firstTwo.find((run) => run.failure)?.failure;
  return { state: 'NOT_REPRODUCED', matched: 0, total, detail: first?.detail ?? 'Not reproduced.' };
}

export type AttemptOutcome =
  | { state: 'PENDING'; passed: number; total: number; needsControl?: boolean }
  | { state: 'FIX_VERIFIED'; passed: number; total: number }
  | { state: 'STILL_FAILING'; passed: number; total: number; detail: string }
  | { state: 'COULDNT_VERIFY'; passed: number; total: number; detail: string; requalify?: boolean };

/**
 * One verification attempt: the first counted failure is Still failing; two consecutive counted
 * passes with no uncounted run in between are Fix verified (after the control run when one is
 * due); any infrastructure or pre-execution outcome is Couldn't verify.
 */
export function attemptOutcome(
  candidates: Pick<BugReplayRunRecord, 'outcome' | 'counted' | 'failure' | 'state'>[],
  control: Pick<BugReplayRunRecord, 'outcome' | 'counted' | 'failure' | 'state'> | undefined,
  controlDue: boolean
): AttemptOutcome {
  const settled = candidates.filter((run) => run.state === 'SETTLED');
  const pending = settled.length < candidates.length;
  let passed = 0;
  let interrupted: (typeof candidates)[number] | undefined;
  for (const run of settled) {
    if (run.outcome === 'FAILED') {
      return { state: 'STILL_FAILING', passed, total: 2, detail: run.failure?.detail ?? 'Still failing' };
    }
    if (run.outcome === 'PASSED') {
      passed += 1;
      continue;
    }
    // A restart cut this run short; the attempt runs it again, so it decides nothing.
    if (run.outcome === 'INTERRUPTED') {
      interrupted = run;
      continue;
    }
    return {
      state: 'COULDNT_VERIFY',
      passed,
      total: 2,
      detail: run.failure?.detail ?? "Couldn't verify: the clean copy didn't start"
    };
  }
  if (passed < 2 && !pending && interrupted) {
    return { state: 'COULDNT_VERIFY', passed, total: 2, detail: interrupted.failure?.detail ?? 'Task Monki closed during this run.' };
  }
  if (passed < 2) return { state: 'PENDING', passed, total: 2 };
  if (!controlDue) return { state: 'FIX_VERIFIED', passed, total: 2 };
  if (!control || control.state !== 'SETTLED') return { state: 'PENDING', passed, total: 2, needsControl: true };
  if (control.outcome === 'REPRODUCED') return { state: 'FIX_VERIFIED', passed, total: 2 };
  if (control.outcome === 'NOT_REPRODUCED') {
    return { state: 'COULDNT_VERIFY', passed, total: 2, detail: "Couldn't verify: the bug no longer shows on the recorded code", requalify: true };
  }
  return { state: 'COULDNT_VERIFY', passed, total: 2, detail: control.failure?.detail ?? "Couldn't verify: the clean copy didn't start" };
}

/** Signature checks whose observed value must match between the two qualification runs. */
export function volatileComparisonIds(document: BugCaseV1): Set<string> {
  return new Set(document.failureSignature.filter((entry) => entry.mode === 'ANY_MISMATCH').map((entry) => entry.assertionId));
}
