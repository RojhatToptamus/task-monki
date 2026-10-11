import { describe, expect, it } from 'vitest';
import type { AgentReviewFinding } from '../../shared/contracts';
import { buildReviewRequestInstruction, formatCommentLocation, planReviewRequest } from './reviewFollowUp';
import type { ReviewFindingView } from './reviewWorkspace';

const finding = (id: string, severity: AgentReviewFinding['severity'], extra: Partial<AgentReviewFinding> = {}): AgentReviewFinding => ({
  id, severity, title: `${id} title`, explanation: `${id} explanation`, ...extra
});

describe('buildReviewRequestInstruction', () => {
  it('sends every open finding and comment, and names dismissed findings as off limits', () => {
    const text = buildReviewRequestInstruction({
      taskTitle: 'Rate-limit the public API',
      summary: 'Limiter state is per process.',
      findings: [finding('f1', 'MAJOR', { path: 'src/rateLimit.ts', line: 41, recommendation: 'Use Redis.' })],
      dismissed: [{ finding: finding('f2', 'MINOR'), reason: 'ACCEPTED', note: 'Covered by the auth tests' }],
      comments: [
        { id: 'c1', path: 'src/rateLimit.ts', side: 'NEW', line: 77, text: 'Return seconds here.' },
        { id: 'c2', path: 'src/rateLimit.ts', side: 'OLD', line: 12, endLine: 14, text: 'Keep this guard.' }
      ],
      note: 'Keep the public signature.'
    });

    expect(text).toContain('1. [Major] f1 title');
    expect(text).toContain('Location: src/rateLimit.ts:41');
    expect(text).toContain('Fix: Use Redis.');
    expect(text).toContain('- src/rateLimit.ts:77: Return seconds here.');
    expect(text).toContain('- src/rateLimit.ts (removed lines 12-14): Keep this guard.');
    expect(text).toContain('- [Minor] f2 title (accepted as is: Covered by the auth tests)');
    expect(text).toContain('Keep the public signature.');
    expect(text).not.toContain('f2 explanation');
  });

  it('falls back to the raw review output only when there is nothing structured to send', () => {
    const raw = buildReviewRequestInstruction({ taskTitle: 'T', findings: [], dismissed: [], comments: [], reviewOutput: 'Unstructured review.' });
    const withComment = buildReviewRequestInstruction({
      taskTitle: 'T', findings: [], dismissed: [], comments: [{ id: 'c', path: 'a.ts', side: 'NEW', text: 'Rename this.' }], reviewOutput: 'Unstructured review.'
    });

    expect(raw).toContain('Unstructured review.');
    expect(withComment).not.toContain('Unstructured review.');
    expect(withComment).toContain('- a.ts (whole file): Rename this.');
  });
});

describe('planReviewRequest', () => {
  const view = (id: string, severity: ReviewFindingView['severity'], state: ReviewFindingView['state'] = 'OPEN'): ReviewFindingView => ({
    ...finding(id, severity), state, addedByReviewer: false
  });
  const findings = [view('leak', 'MAJOR'), view('year', 'MINOR'), view('color', 'NIT'), view('test', 'MINOR', 'DISMISSED')];

  it('sends blocking findings and the suggestions the person added in this review', () => {
    const plan = planReviewRequest(findings, { includedFindingIds: ['year'], reviewRunId: 'review-2' }, 'review-2');
    expect(plan.send.map((item) => item.id)).toEqual(['leak', 'year']);
    expect(plan.suggestions.map((item) => item.id)).toEqual(['color']);
    expect(plan.settled.map((item) => item.id)).toEqual(['test']);
  });

  it('drops inclusions made in an earlier review', () => {
    const plan = planReviewRequest(findings, { includedFindingIds: ['year'], reviewRunId: 'review-1' }, 'review-2');
    expect(plan.send.map((item) => item.id)).toEqual(['leak']);
  });

  it('formats lines, ranges, removed lines and whole files', () => {
    expect(formatCommentLocation({ path: 'a.ts', side: 'NEW', line: 3 })).toBe('a.ts:3');
    expect(formatCommentLocation({ path: 'a.ts', side: 'NEW', line: 3, endLine: 5 })).toBe('a.ts:3-5');
    expect(formatCommentLocation({ path: 'a.ts', side: 'OLD', line: 3 })).toBe('a.ts (removed line 3)');
    expect(formatCommentLocation({ path: 'a.ts', side: 'NEW' })).toBe('a.ts (whole file)');
  });
});
