import { describe, expect, it } from 'vitest';
import type { AgentReviewFinding } from '../../shared/contracts';
import { buildReviewRequestInstruction } from './reviewFollowUp';

const finding = (id: string, severity: AgentReviewFinding['severity'], extra: Partial<AgentReviewFinding> = {}): AgentReviewFinding => ({
  id, severity, title: `${id} title`, explanation: `${id} explanation`, ...extra
});

describe('buildReviewRequestInstruction', () => {
  it('sends every open finding and comment, and names dismissed findings as off limits', () => {
    const text = buildReviewRequestInstruction({
      taskTitle: 'Rate-limit the public API',
      summary: 'Limiter state is per process.',
      findings: [finding('f1', 'MAJOR', { path: 'src/rateLimit.ts', line: 41, recommendation: 'Use Redis.' })],
      dismissed: [{ finding: finding('f2', 'MINOR'), note: 'Covered by the auth tests' }],
      comments: [{ id: 'c1', path: 'src/rateLimit.ts', line: 77, text: 'Return seconds here.' }],
      note: 'Keep the public signature.'
    });

    expect(text).toContain('1. [Major] f1 title');
    expect(text).toContain('Location: src/rateLimit.ts:41');
    expect(text).toContain('Fix: Use Redis.');
    expect(text).toContain('- src/rateLimit.ts:77: Return seconds here.');
    expect(text).toContain('- [Minor] f2 title (Covered by the auth tests)');
    expect(text).toContain('Keep the public signature.');
    expect(text).not.toContain('f2 explanation');
  });

  it('falls back to the raw review output only when there is nothing structured to send', () => {
    const raw = buildReviewRequestInstruction({ taskTitle: 'T', findings: [], dismissed: [], comments: [], reviewOutput: 'Unstructured review.' });
    const withComment = buildReviewRequestInstruction({
      taskTitle: 'T', findings: [], dismissed: [], comments: [{ id: 'c', path: 'a.ts', text: 'Rename this.' }], reviewOutput: 'Unstructured review.'
    });

    expect(raw).toContain('Unstructured review.');
    expect(withComment).not.toContain('Unstructured review.');
    expect(withComment).toContain('- a.ts: Rename this.');
  });
});
