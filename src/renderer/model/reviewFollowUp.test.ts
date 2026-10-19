import { describe, expect, it } from 'vitest';
import type { AgentReviewFinding } from '../../shared/contracts';
import { formatCommentLocation } from './formatting';
import { buildReviewRequestInstruction, buildReviewRequestRecord, planReviewRequest } from './reviewFollowUp';
import type { ReviewFindingView } from './reviewWorkspace';

const finding = (id: string, severity: AgentReviewFinding['severity'], extra: Partial<AgentReviewFinding> = {}): AgentReviewFinding => ({
  id, severity, title: `${id} title`, explanation: `${id} explanation`, ...extra
});

describe('buildReviewRequestInstruction', () => {
  it('sends every open finding and comment in one numbering, and names dismissed findings as off limits', () => {
    const input = {
      taskTitle: 'Rate-limit the public API',
      reviewRunId: 'review-1',
      summary: 'Limiter state is per process.',
      findings: [finding('f1', 'MAJOR', { path: 'src/rateLimit.ts', line: 41, recommendation: 'Use Redis.' })],
      dismissed: [{ finding: finding('f2', 'MINOR'), reason: 'ACCEPTED', note: 'Covered by the auth tests' }],
      comments: [
        { id: 'c1', path: 'src/rateLimit.ts', side: 'NEW', line: 77, text: 'Return seconds here.' },
        { id: 'c2', path: 'src/rateLimit.ts', side: 'OLD', line: 12, endLine: 14, text: 'Keep this guard.' }
      ],
      note: 'Keep the public signature.'
    } as const;
    const text = buildReviewRequestInstruction({ ...input, comments: [...input.comments], findings: [...input.findings], dismissed: [...input.dismissed] });

    expect(text).toContain('1. [Major] f1 title');
    expect(text).toContain('Location: src/rateLimit.ts:41');
    expect(text).toContain('Fix: Use Redis.');
    expect(text).toContain('2. src/rateLimit.ts:77: Return seconds here.');
    expect(text).toContain('3. src/rateLimit.ts (removed lines 12-14): Keep this guard.');
    expect(text).toContain('- [Minor] f2 title (intentional: Covered by the auth tests)');
    expect(text).toContain('Keep the public signature.');
    expect(text).not.toContain('f2 explanation');
    // The agent answers each numbered item in a block the Review tab reads.
    expect(text).toContain('End your reply with a task-monki-review-response block that answers every numbered item above');

    expect(buildReviewRequestRecord({ ...input, comments: [...input.comments], findings: [...input.findings], dismissed: [] })).toEqual({
      reviewRunId: 'review-1',
      items: [
        { number: 1, kind: 'FINDING', findingId: 'f1', severity: 'MAJOR', title: 'f1 title', path: 'src/rateLimit.ts', line: 41 },
        { number: 2, kind: 'COMMENT', path: 'src/rateLimit.ts', side: 'NEW', line: 77, text: 'Return seconds here.' },
        { number: 3, kind: 'COMMENT', path: 'src/rateLimit.ts', side: 'OLD', line: 12, endLine: 14, text: 'Keep this guard.' }
      ],
      note: 'Keep the public signature.'
    });
  });

  it('falls back to the raw review output only when there is nothing structured to send', () => {
    const raw = buildReviewRequestInstruction({ taskTitle: 'T', findings: [], dismissed: [], comments: [], reviewOutput: 'Unstructured review.' });
    const withComment = buildReviewRequestInstruction({
      taskTitle: 'T', findings: [], dismissed: [], comments: [{ id: 'c', path: 'a.ts', side: 'NEW', text: 'Rename this.' }], reviewOutput: 'Unstructured review.'
    });

    expect(raw).toContain('Unstructured review.');
    // Raw output has no numbered items, so nothing asks for item answers.
    expect(raw).not.toContain('task-monki-review-response');
    expect(buildReviewRequestRecord({ taskTitle: 'T', findings: [], dismissed: [], comments: [], reviewOutput: 'Unstructured review.' })).toBeUndefined();
    expect(withComment).not.toContain('Unstructured review.');
    expect(withComment).toContain('1. a.ts (whole file): Rename this.');
  });
});

describe('planReviewRequest', () => {
  const view = (id: string, severity: ReviewFindingView['severity'], state: ReviewFindingView['state'] = 'OPEN'): ReviewFindingView => ({
    ...finding(id, severity), state
  });
  const findings = [view('leak', 'MAJOR'), view('year', 'MINOR'), view('color', 'NIT'), view('test', 'MINOR', 'DISMISSED')];
  const draft = { includedFindingIds: [], reviewRunId: 'review-2', comments: [], note: '' };
  const current = { runId: 'review-2', findingsSendable: true, asksForChanges: true };

  it('sends blocking findings and the suggestions the person added in this review', () => {
    const plan = planReviewRequest(findings, { ...draft, includedFindingIds: ['year'], reviewRunId: 'review-2' }, current);
    expect(plan.send.map((item) => item.id)).toEqual(['leak', 'year']);
    expect(plan.suggestions.map((item) => item.id)).toEqual(['color']);
    expect(plan.settled.map((item) => item.id)).toEqual(['test']);
    expect(plan.queued).toBe(true);
  });

  it('sends only comments and the note for a review that is context only', () => {
    const plan = planReviewRequest(findings, draft, { ...current, findingsSendable: false });
    expect([...plan.send, ...plan.suggestions, ...plan.settled]).toEqual([]);
    expect(plan.queued).toBe(false);
    expect(planReviewRequest(findings, { ...draft, note: 'Keep the API.' }, { ...current, findingsSendable: false }).queued).toBe(true);
  });

  it('sends the notes of a review that asks for changes without structured findings', () => {
    const plan = planReviewRequest([], draft, current);
    expect(plan).toMatchObject({ reviewNotes: true, queued: true });
  });

  it('drops inclusions made in an earlier review', () => {
    const plan = planReviewRequest(findings, { ...draft, includedFindingIds: ['year'], reviewRunId: 'review-1' }, current);
    expect(plan.send.map((item) => item.id)).toEqual(['leak']);
  });

  it('formats lines, ranges, removed lines and whole files', () => {
    expect(formatCommentLocation({ path: 'a.ts', side: 'NEW', line: 3 })).toBe('a.ts:3');
    expect(formatCommentLocation({ path: 'a.ts', side: 'NEW', line: 3, endLine: 5 })).toBe('a.ts:3-5');
    expect(formatCommentLocation({ path: 'a.ts', side: 'OLD', line: 3 })).toBe('a.ts (removed line 3)');
    expect(formatCommentLocation({ path: 'a.ts', side: 'NEW' })).toBe('a.ts (whole file)');
  });
});
