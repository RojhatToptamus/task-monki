import type { BugReplayGateProjection, BugReplayGateState, BugReplayWaitReason } from './bugReplay';

/**
 * The one formatter for what Task Monki says about a bug. Every surface (the Overview, the
 * board, the Inbox, the Review brief, the reviewer's prompt and the pull request) takes its words
 * from here, so no surface can claim more than another.
 */

export type BugStateTone = 'neutral' | 'action' | 'working' | 'success' | 'error';

export interface BugStateWord {
  word: string;
  tone: BugStateTone;
  /** The person owes a step for this state. */
  owed: boolean;
}

/** One name per state, each naming its subject, read by every surface including History. */
const WORDS: Record<BugReplayGateState, BugStateWord> = {
  CAPTURED: { word: 'Bug recorded', tone: 'neutral', owed: false },
  REPRODUCING: { word: 'Reproducing bug', tone: 'working', owed: false },
  REPRODUCED: { word: 'Bug reproduced', tone: 'neutral', owed: true },
  NOT_REPRODUCED: { word: 'Bug not reproduced', tone: 'action', owed: true },
  FLAKY: { word: 'Bug reproduced sometimes', tone: 'action', owed: true },
  REPRODUCTION_BLOCKED: { word: 'Replay blocked', tone: 'error', owed: true },
  VERIFYING: { word: 'Verifying fix', tone: 'working', owed: false },
  FIX_VERIFIED: { word: 'Fix verified', tone: 'success', owed: false },
  STILL_FAILING: { word: 'Bug still failing', tone: 'error', owed: true },
  COULDNT_VERIFY: { word: "Couldn't verify the fix", tone: 'action', owed: true },
  STALE: { word: 'Verification out of date', tone: 'action', owed: false }
};

/** How stored facts open, by state: "Couldn't verify: .env changed…". Older wording included. */
const FACT_LEADS: Partial<Record<BugReplayGateState, string[]>> = {
  NOT_REPRODUCED: ['not reproduced'],
  FLAKY: ['flaky', 'bug reproduced only sometimes'],
  REPRODUCTION_BLOCKED: ['reproduction blocked', 'bug reproduction blocked'],
  STILL_FAILING: ['still failing'],
  COULDNT_VERIFY: ["couldn't verify"],
  STALE: ['fix verification out of date']
};

/** The words for replays that wait on the person's approval, on every surface. */
export const BUG_APPROVAL_WORD = 'Replays need approval';

/** The word for a bug's state on every surface, with the decisions the person owes first. */
export function bugStateWord(
  gate: Pick<BugReplayGateProjection, 'state'> & { activeRun?: { waitingFor?: BugReplayWaitReason }; handoff?: { status: string } }
): BugStateWord {
  const waiting = gate.activeRun?.waitingFor;
  if (waiting === 'APPROVAL') return { word: BUG_APPROVAL_WORD, tone: 'action', owed: true };
  if (waiting === 'KEYSTORE') return { word: 'Secrets locked', tone: 'action', owed: true };
  if (gate.handoff && (gate.handoff.status === 'QUEUED' || gate.handoff.status === 'RUNNING')) {
    return { word: 'Fixing the bug', tone: 'working', owed: false };
  }
  return WORDS[gate.state];
}

export function bugStateBaseWord(state: BugReplayGateState): string {
  return WORDS[state].word;
}

/** "Replays: reproduced 2 of 2 before the fix, passed 2 of 2 after". One polarity per side. */
export function bugCountsLine(gate: Pick<BugReplayGateProjection, 'baseline' | 'candidate'> & { state?: BugReplayGateState }): string | undefined {
  const parts = bugCountParts(gate);
  const words = [
    parts.reproduced ? `reproduced ${parts.reproduced.count} of ${parts.reproduced.total} before the fix` : undefined,
    parts.passed ? `passed ${parts.passed.count} of ${parts.passed.total} after` : undefined
  ].filter(Boolean);
  return words.length ? `Replays: ${words.join(', ')}` : undefined;
}

/** The counts the replays support: how many reproduced the bug, and how many passed on the fix. */
export function bugCountParts(gate: Pick<BugReplayGateProjection, 'baseline' | 'candidate'> & { state?: BugReplayGateState }): {
  reproduced?: { count: number; total: number };
  passed?: { count: number; total: number };
} {
  const parts: ReturnType<typeof bugCountParts> = {};
  if (gate.baseline && gate.baseline.matched > 0) parts.reproduced = { count: gate.baseline.matched, total: gate.baseline.total };
  // While a verification runs, its counts are not a result yet; one that could not run checked nothing.
  const counted = gate.state === 'COULDNT_VERIFY' ? (gate.candidate?.passed ?? 0) > 0 : gate.state !== 'VERIFYING';
  if (gate.candidate && counted && (gate.candidate.passed > 0 || gate.candidate.total > 0)) {
    parts.passed = { count: gate.candidate.passed, total: gate.candidate.total };
  }
  return parts;
}

/**
 * The gate's fact without the state word it may open with, for surfaces that show that word
 * beside it: under "Couldn't verify", "Couldn't verify: .env changed…" reads ".env changed…".
 */
export function bugReason(gate: Pick<BugReplayGateProjection, 'state' | 'fact'>): string | undefined {
  const fact = gate.fact?.trim();
  if (!fact) return undefined;
  const words = [WORDS[gate.state].word.toLowerCase(), ...(FACT_LEADS[gate.state] ?? [])];
  for (const lead of words.flatMap((word) => [`${word}: `, `${word}. `])) {
    if (!fact.toLowerCase().startsWith(lead)) continue;
    const rest = fact.slice(lead.length).trim();
    return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : undefined;
  }
  return fact;
}

/** A clean copy's service that stopped, as a sentence: "The web service stopped", or "The app stopped" when no service is named. */
export function serviceStoppedSentence(service: string | undefined): string {
  const name = service?.trim();
  return !name || name === 'the app' ? 'The app stopped' : `The ${name} service stopped`;
}

/** What the check covered, always ending with the database statement. */
export function bugScopeLine(alsoAfterReload: boolean, keepBrowserStorage: boolean): string {
  if (alsoAfterReload) {
    return keepBrowserStorage
      ? "Checked in the app's pages after reload, browser storage kept. Database contents were not read."
      : "Checked in the app's pages after reload. Database contents were not read.";
  }
  return 'Checked on the page. Database contents were not read.';
}

export const BUG_BOUNDARY_LINE = "Not controlled: services the app connects to itself, the server's network, the clock.";

/** What a suggested bug title is built from: the first expectation and what its element showed. */
export interface BugTitleSeed {
  /** The element's name: "Cart total". */
  label: string;
  template: 'equals' | 'contains' | 'visible' | 'hidden' | 'count';
  expected?: string;
  count?: number;
  /** What the element showed when the bug was marked. */
  shown?: string;
}

/**
 * A title that states what should be true, so it still reads right once the fix is verified:
 * 'Cart total should read "$45.00"'. Until the expectation differs from what the element showed,
 * it states the observation: 'Cart total shows "$40.00"'. Without an element there is no
 * suggestion; the person names the bug.
 */
export function suggestBugTitle(seed: BugTitleSeed | undefined): string {
  if (!seed) return '';
  const flat = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const quoted = (value: string) => `"${value.length > 40 ? `${value.slice(0, 39)}…` : value}"`;
  switch (seed.template) {
    case 'equals':
    case 'contains': {
      const expected = flat(seed.expected);
      const shown = flat(seed.shown);
      if (!expected || expected === shown) return shown ? `${seed.label} shows ${quoted(shown)}` : `${seed.label} is empty`;
      return `${seed.label} should ${seed.template === 'equals' ? 'read' : 'contain'} ${quoted(expected)}`;
    }
    case 'visible':
      return `${seed.label} should be visible`;
    case 'hidden':
      return `${seed.label} should be hidden`;
    case 'count':
      return `${seed.label} should appear ${seed.count === 1 ? 'once' : `${seed.count ?? 0} times`}`;
  }
}
