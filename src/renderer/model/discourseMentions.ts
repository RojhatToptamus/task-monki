export const DISCOURSE_MENTION_HISTORY_LIMIT = 20;
export const DISCOURSE_MENTION_RESULT_LIMIT = 60;
/**
 * Shipping default keeps structured mentions in the accessible token trays.
 * Inline-label mode remains behind an explicit seam until its browser and
 * assistive-technology acceptance pass is complete.
 */
export const DEFAULT_DISCOURSE_MENTION_SELECTION_MODE = 'TOKEN_ONLY' as const;

export type DiscourseMentionKind = 'AGENT' | 'TASK' | 'REPOSITORY';
export type DiscourseMentionSelectionMode = 'INLINE_LABEL' | 'TOKEN_ONLY';

export interface DiscourseMentionCandidate {
  kind: DiscourseMentionKind;
  id: string;
  label: string;
  description: string;
  searchAliases: string[];
  available: boolean;
  recentOrdinal?: number;
}

export interface DiscourseMentionQuery {
  start: number;
  end: number;
  query: string;
}

export interface DiscourseComposerToken {
  key: string;
  kind: DiscourseMentionKind;
  entityId: string;
  labelSnapshot: string;
  available: boolean;
}

interface DiscourseComposerSnapshot {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  tokens: DiscourseComposerToken[];
}

interface DiscourseMentionTransaction {
  before: DiscourseComposerSnapshot;
  after: DiscourseComposerSnapshot;
}

export interface DiscourseComposerMentionState extends DiscourseComposerSnapshot {
  composing: boolean;
  undoSelections: DiscourseMentionTransaction[];
  redoSelections: DiscourseMentionTransaction[];
  announcement: string;
}

export function lastRenderedDiscourseComposerToken(
  state: Pick<DiscourseComposerMentionState, 'tokens'>,
  showAgentTokens: boolean
): DiscourseComposerToken | undefined {
  return state.tokens.filter((token) => showAgentTokens || token.kind !== 'AGENT').at(-1);
}

export function createDiscourseComposerMentionState(
  text = ''
): DiscourseComposerMentionState {
  return {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
    tokens: [],
    composing: false,
    undoSelections: [],
    redoSelections: [],
    announcement: ''
  };
}

export function findDiscourseMentionQuery(input: {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  composing: boolean;
}): DiscourseMentionQuery | undefined {
  if (input.composing || input.selectionStart !== input.selectionEnd) return undefined;
  const cursor = clampCursor(input.selectionStart, input.text.length);
  const lineStart = input.text.lastIndexOf('\n', cursor - 1) + 1;
  const minimum = Math.max(lineStart, cursor - 65);
  for (let index = cursor - 1; index >= minimum; index -= 1) {
    const character = input.text[index];
    if (character !== '@') continue;
    const before = input.text[index - 1];
    if (before !== undefined && !/[\s([{'"“‘]/u.test(before)) return undefined;
    const query = input.text.slice(index + 1, cursor);
    if (!/^[\p{L}\p{N}\p{M} ._/#-]{0,64}$/u.test(query)) return undefined;
    return { start: index, end: cursor, query };
  }
  return undefined;
}

export function updateDiscourseComposerText(
  state: DiscourseComposerMentionState,
  input: { text: string; selectionStart: number; selectionEnd: number }
): DiscourseComposerMentionState {
  return {
    ...state,
    text: input.text,
    selectionStart: clampCursor(input.selectionStart, input.text.length),
    selectionEnd: clampCursor(input.selectionEnd, input.text.length),
    redoSelections: [],
    announcement: ''
  };
}

export function setDiscourseComposerComposition(
  state: DiscourseComposerMentionState,
  composing: boolean
): DiscourseComposerMentionState {
  return { ...state, composing };
}

export function selectDiscourseMention(
  state: DiscourseComposerMentionState,
  query: DiscourseMentionQuery,
  candidate: DiscourseMentionCandidate,
  mode: DiscourseMentionSelectionMode
): DiscourseComposerMentionState {
  if (state.composing) throw new Error('A mention cannot be selected during text composition.');
  if (!candidate.available) throw new Error('Unavailable mention results cannot be selected.');
  if (
    query.start < 0 ||
    query.end < query.start ||
    query.end > state.text.length ||
    state.text[query.start] !== '@'
  ) {
    throw new Error('The active mention query is stale.');
  }

  const before = snapshot(state);
  const label = readableMentionLabel(candidate.label);
  const existing = state.tokens.some(
    (token) => token.kind === candidate.kind && token.entityId === candidate.id
  );
  const tokens = existing
    ? state.tokens
    : [
        ...state.tokens,
        {
          key: `${candidate.kind}:${candidate.id}`,
          kind: candidate.kind,
          entityId: candidate.id,
          labelSnapshot: label,
          available: true
        }
      ];
  let text = state.text;
  let selectionStart = state.selectionStart;
  let selectionEnd = state.selectionEnd;
  if (mode === 'INLINE_LABEL') {
    const suffix = state.text.slice(query.end);
    const spacing = suffix.length === 0 || !/^[\s,.;:!?)}\]]/u.test(suffix) ? ' ' : '';
    const replacement = `@${label}${spacing}`;
    text = `${state.text.slice(0, query.start)}${replacement}${suffix}`;
    selectionStart = query.start + replacement.length;
    selectionEnd = selectionStart;
  } else {
    const prefix = state.text.slice(0, query.start);
    const suffix = state.text.slice(query.end);
    const joinedSuffix = /[\t ]$/u.test(prefix) && /^[\t ]/u.test(suffix)
      ? suffix.slice(1)
      : suffix;
    text = `${prefix}${joinedSuffix}`;
    selectionStart = prefix.length;
    selectionEnd = selectionStart;
  }
  const after: DiscourseComposerSnapshot = {
    text,
    selectionStart,
    selectionEnd,
    tokens
  };
  return {
    ...after,
    composing: false,
    undoSelections: [...state.undoSelections, { before, after }].slice(
      -DISCOURSE_MENTION_HISTORY_LIMIT
    ),
    redoSelections: [],
    announcement: `${label} added to ${candidate.kind === 'AGENT' ? 'Ask' : 'Context'}.`
  };
}

export function canUndoDiscourseMentionSelection(
  state: DiscourseComposerMentionState
): boolean {
  const transaction = state.undoSelections.at(-1);
  return Boolean(transaction && sameComposerContent(state, transaction.after));
}

export function undoDiscourseMentionSelection(
  state: DiscourseComposerMentionState
): DiscourseComposerMentionState {
  const transaction = state.undoSelections.at(-1);
  if (!transaction || !sameComposerContent(state, transaction.after)) return state;
  return {
    ...transaction.before,
    composing: false,
    undoSelections: state.undoSelections.slice(0, -1),
    redoSelections: [...state.redoSelections, transaction].slice(
      -DISCOURSE_MENTION_HISTORY_LIMIT
    ),
    announcement: 'Mention selection undone.'
  };
}

export function canRedoDiscourseMentionSelection(
  state: DiscourseComposerMentionState
): boolean {
  const transaction = state.redoSelections.at(-1);
  return Boolean(transaction && sameComposerContent(state, transaction.before));
}

export function redoDiscourseMentionSelection(
  state: DiscourseComposerMentionState
): DiscourseComposerMentionState {
  const transaction = state.redoSelections.at(-1);
  if (!transaction || !sameComposerContent(state, transaction.before)) return state;
  return {
    ...transaction.after,
    composing: false,
    undoSelections: [...state.undoSelections, transaction].slice(
      -DISCOURSE_MENTION_HISTORY_LIMIT
    ),
    redoSelections: state.redoSelections.slice(0, -1),
    announcement: 'Mention selection restored.'
  };
}

export function removeDiscourseComposerToken(
  state: DiscourseComposerMentionState,
  tokenKey: string
): DiscourseComposerMentionState {
  const token = state.tokens.find((candidate) => candidate.key === tokenKey);
  if (!token) return state;
  return {
    ...state,
    tokens: state.tokens.filter((candidate) => candidate.key !== tokenKey),
    redoSelections: [],
    announcement: `${token.labelSnapshot} removed from ${
      token.kind === 'AGENT' ? 'Ask' : 'Context'
    }.`
  };
}

export function rankDiscourseMentionCandidates(
  candidates: readonly DiscourseMentionCandidate[],
  query: string,
  limit = DISCOURSE_MENTION_RESULT_LIMIT
): DiscourseMentionCandidate[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DISCOURSE_MENTION_RESULT_LIMIT) {
    throw new Error('Mention result limit is invalid.');
  }
  const normalizedQuery = normalizeSearchText(query);
  const ranked = candidates
    .flatMap((candidate) => {
      const score = mentionMatchScore(candidate, normalizedQuery);
      return score === undefined ? [] : [{ candidate, score }];
    })
    .sort((left, right) => {
      const group = mentionKindOrder(left.candidate.kind) - mentionKindOrder(right.candidate.kind);
      if (group !== 0) return group;
      if (left.score !== right.score) return left.score - right.score;
      const recent = (right.candidate.recentOrdinal ?? -1) - (left.candidate.recentOrdinal ?? -1);
      if (recent !== 0) return recent;
      return compareCodeUnits(left.candidate.label, right.candidate.label) ||
        compareCodeUnits(left.candidate.id, right.candidate.id);
    });
  const minimumPerKind = Math.min(10, Math.max(1, Math.floor(limit / 3)));
  const selected = new Set<string>();
  const result: typeof ranked = [];
  for (const kind of ['AGENT', 'TASK', 'REPOSITORY'] as const) {
    if (result.length >= limit) break;
    for (const match of ranked.filter((entry) => entry.candidate.kind === kind)) {
      if (result.length >= limit) break;
      if (result.filter((entry) => entry.candidate.kind === kind).length >= minimumPerKind) {
        break;
      }
      selected.add(`${match.candidate.kind}:${match.candidate.id}`);
      result.push(match);
    }
  }
  for (const match of ranked) {
    if (result.length >= limit) break;
    const key = `${match.candidate.kind}:${match.candidate.id}`;
    if (selected.has(key)) continue;
    selected.add(key);
    result.push(match);
  }
  return result
    .sort((left, right) => {
      const group = mentionKindOrder(left.candidate.kind) - mentionKindOrder(right.candidate.kind);
      if (group !== 0) return group;
      if (left.score !== right.score) return left.score - right.score;
      const recent = (right.candidate.recentOrdinal ?? -1) - (left.candidate.recentOrdinal ?? -1);
      if (recent !== 0) return recent;
      return compareCodeUnits(left.candidate.label, right.candidate.label) ||
        compareCodeUnits(left.candidate.id, right.candidate.id);
    })
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function moveDiscourseMentionActiveOption(input: {
  optionIds: readonly string[];
  activeId?: string;
  key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';
}): string | undefined {
  if (input.optionIds.length === 0) return undefined;
  if (input.key === 'Home') return input.optionIds[0];
  if (input.key === 'End') return input.optionIds.at(-1);
  const current = input.activeId ? input.optionIds.indexOf(input.activeId) : -1;
  if (input.key === 'ArrowDown') {
    return input.optionIds[current < 0 ? 0 : (current + 1) % input.optionIds.length];
  }
  return input.optionIds[
    current < 0 ? input.optionIds.length - 1 : (current - 1 + input.optionIds.length) % input.optionIds.length
  ];
}

function mentionMatchScore(
  candidate: DiscourseMentionCandidate,
  query: string
): number | undefined {
  if (!query) return candidate.recentOrdinal === undefined ? 500 : 0;
  const label = normalizeSearchText(candidate.label);
  const values = [label, normalizeSearchText(candidate.id), ...candidate.searchAliases.map(normalizeSearchText)];
  if (label === query) return 0;
  if (label.startsWith(query)) return 10;
  if (label.split(' ').some((word) => word.startsWith(query))) return 20;
  if (values.some((value) => value.startsWith(query))) return 30;
  if (values.some((value) => value.includes(query))) return 40;
  if (values.some((value) => isSubsequence(query, value))) return 60;
  return undefined;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isSubsequence(query: string, value: string): boolean {
  let queryIndex = 0;
  for (const character of value) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function readableMentionLabel(value: string): string {
  const label = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  if (!label) throw new Error('Mention label is empty after sanitization.');
  return label;
}

function snapshot(state: DiscourseComposerMentionState): DiscourseComposerSnapshot {
  return {
    text: state.text,
    selectionStart: state.selectionStart,
    selectionEnd: state.selectionEnd,
    tokens: state.tokens.map((token) => ({ ...token }))
  };
}

function sameComposerContent(
  state: Pick<DiscourseComposerSnapshot, 'text' | 'tokens'>,
  snapshotValue: DiscourseComposerSnapshot
): boolean {
  return state.text === snapshotValue.text && JSON.stringify(state.tokens) === JSON.stringify(snapshotValue.tokens);
}

function clampCursor(value: number, length: number): number {
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(length, value)) : length;
}

function mentionKindOrder(kind: DiscourseMentionKind): number {
  return kind === 'AGENT' ? 0 : kind === 'REPOSITORY' ? 1 : 2;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
