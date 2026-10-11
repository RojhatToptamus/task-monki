import { describe, expect, it } from 'vitest';
import {
  effectiveReviewFindings,
  type AgentReviewResult
} from '../../shared/contracts';
import { parseReviewedDiff } from './ReviewedDiff';
import { reviewerRevisionDecisions, reviewerRevisionsFromReply } from './ReviewerRevisions';

const DIFF = [
  '# Git diff evidence',
  '',
  '## Diff stat',
  '',
  ' src/a.ts | 2 +-',
  '',
  '## Committed diff',
  '',
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '',
  '## Staged diff',
  '',
  'No staged diff.',
  '',
  '## Unstaged diff',
  '',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..0000000',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+export const added = true;',
  ''
].join('\n');

const result: AgentReviewResult = {
  schemaVersion: 'agent-review/v1',
  verdict: 'NEEDS_CHANGES',
  summary: 'Problems found.',
  findings: [
    { id: 'leak', severity: 'MAJOR', title: 'Listener leaks', explanation: 'Never removed.', path: 'src/a.ts', line: 2 },
    { id: 'gone', severity: 'NIT', title: 'Gone', explanation: 'Withdrawn earlier.' }
  ]
};
const findings = effectiveReviewFindings(result, [{
  id: 'earlier', reviewRunId: 'review', findingId: 'gone', kind: 'WITHDRAW', actor: 'REVIEWER',
  reason: 'Not an issue.', questionRunId: 'question-0', createdAt: '2026-10-10T10:00:00.000Z'
}]);
const context = { findings, diffPaths: new Set(parseReviewedDiff(DIFF).map((file) => file.path)) };

function reply(entries: unknown): string {
  return `My answer.\n\n\`\`\`task-monki-revisions\n${typeof entries === 'string' ? entries : JSON.stringify(entries)}\n\`\`\``;
}

describe('reviewer revision blocks', () => {
  it('reads every changed path of the reviewed diff, including untracked files', () => {
    expect([...context.diffPaths]).toEqual(['src/a.ts', 'src/new.ts']);
    expect(parseReviewedDiff(DIFF).map(({ path, additions, deletions }) => ({ path, additions, deletions }))).toEqual([
      { path: 'src/a.ts', additions: 1, deletions: 1 },
      { path: 'src/new.ts', additions: 1, deletions: 0 }
    ]);
  });

  it('accepts withdraw, severity and add revisions and assigns ids to added findings', () => {
    const outcome = reviewerRevisionsFromReply(reply([
      { finding: 'leak', action: 'severity', severity: 'MINOR', reason: 'Only reachable in tests.' },
      { action: 'add', reason: 'Seen while answering.', finding: {
        severity: 'MAJOR', title: 'Missing export guard', explanation: 'Importers crash.', path: 'src/new.ts', line: 1
      } }
    ]), context);
    expect(outcome).toEqual({
      status: 'VALID',
      revisions: [
        { action: 'severity', findingId: 'leak', severity: 'MINOR', reason: 'Only reachable in tests.' },
        { action: 'add', reason: 'Seen while answering.', finding: {
          severity: 'MAJOR', title: 'Missing export guard', explanation: 'Importers crash.', path: 'src/new.ts', line: 1
        } }
      ]
    });
    if (outcome.status !== 'VALID') return;
    let id = 0;
    const decisions = reviewerRevisionDecisions(outcome.revisions, {
      reviewRunId: 'review',
      questionRunId: 'question-1',
      findings,
      createdAt: '2026-10-10T11:00:00.000Z',
      createId: () => `decision-${(id += 1)}`
    });
    expect(decisions).toEqual([
      expect.objectContaining({ kind: 'CHANGE_SEVERITY', findingId: 'leak', severity: 'MINOR', actor: 'REVIEWER', questionRunId: 'question-1' }),
      expect.objectContaining({ kind: 'ADD', findingId: 'added-1', finding: expect.objectContaining({ id: 'added-1', path: 'src/new.ts' }) })
    ]);
  });

  it('ignores an answer without a revision block', () => {
    expect(reviewerRevisionsFromReply('The finding stands; I would withdraw nothing.', context)).toEqual({ status: 'NONE' });
  });

  it.each([
    ['invalid JSON', reply('[{"finding": "leak",'), 'not valid JSON'],
    ['an object instead of an array', reply({ finding: 'leak', action: 'withdraw', reason: 'x' }), 'JSON array of 1 to 8'],
    ['an empty array', reply([]), 'JSON array of 1 to 8'],
    ['more than eight revisions', reply(Array.from({ length: 9 }, () => ({ finding: 'leak', action: 'withdraw', reason: 'x' }))), 'JSON array of 1 to 8'],
    ['an unknown action', reply([{ finding: 'leak', action: 'dismiss', reason: 'x' }]), 'action must be'],
    ['an extra key', reply([{ finding: 'leak', action: 'withdraw', reason: 'x', note: 'y' }]), 'exactly'],
    ['a missing reason', reply([{ finding: 'leak', action: 'withdraw' }]), 'reason is required'],
    ['a reason over 500 characters', reply([{ finding: 'leak', action: 'withdraw', reason: 'x'.repeat(501) }]), 'longer than 500'],
    ['an invalid severity', reply([{ finding: 'leak', action: 'severity', severity: 'HIGH', reason: 'x' }]), 'severity must be'],
    ['an unchanged severity', reply([{ finding: 'leak', action: 'severity', severity: 'MAJOR', reason: 'x' }]), 'keeps finding leak'],
    ['an unknown finding', reply([{ finding: 'missing', action: 'withdraw', reason: 'x' }]), 'unknown finding'],
    ['a withdrawn finding', reply([{ finding: 'gone', action: 'withdraw', reason: 'x' }]), 'withdrawn finding'],
    ['one finding revised twice', reply([
      { finding: 'leak', action: 'withdraw', reason: 'x' },
      { finding: 'leak', action: 'severity', severity: 'NIT', reason: 'y' }
    ]), 'again'],
    ['an added finding outside the reviewed diff', reply([{ action: 'add', reason: 'x', finding: {
      severity: 'MINOR', title: 'Elsewhere', explanation: 'Outside the diff.', path: 'src/other.ts'
    } }]), 'not part of the reviewed diff'],
    ['an added finding without a title', reply([{ action: 'add', reason: 'x', finding: {
      severity: 'MINOR', title: ' ', explanation: 'No title.', path: 'src/a.ts'
    } }]), 'title is required'],
    ['an added finding with an unsupported field', reply([{ action: 'add', reason: 'x', finding: {
      severity: 'MINOR', title: 'T', explanation: 'E', path: 'src/a.ts', endLine: 4
    } }]), 'unsupported field endLine'],
    ['a block followed by prose', `${reply([{ finding: 'leak', action: 'withdraw', reason: 'x' }])}\nThanks.`, 'must end the answer'],
    ['two revision blocks', `${reply([{ finding: 'leak', action: 'withdraw', reason: 'x' }])}\n\n${reply([{ finding: 'leak', action: 'withdraw', reason: 'x' }])}`, 'more than one revision block']
  ])('rejects %s as a whole', (_name, text, reason) => {
    const outcome = reviewerRevisionsFromReply(text, context);
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.status === 'REJECTED' ? outcome.reason : '').toContain(reason);
  });

  it('keeps a rejection reason short when the answer names a huge finding, path or field', () => {
    const huge = 'x'.repeat(10_000);
    for (const entries of [
      [{ finding: huge, action: 'withdraw', reason: 'x' }],
      [{ action: 'add', reason: 'x', finding: { severity: 'MINOR', title: 'T', explanation: 'E', path: huge.slice(0, 2_000) } }],
      [{ action: 'add', reason: 'x', finding: { severity: 'MINOR', title: 'T', explanation: 'E', path: 'src/a.ts', [huge]: 1 } }]
    ]) {
      const outcome = reviewerRevisionsFromReply(reply(entries), context);
      expect(outcome.status).toBe('REJECTED');
      const reason = outcome.status === 'REJECTED' ? outcome.reason : '';
      expect(reason).toContain('x…');
      expect(reason.length).toBeLessThan(200);
    }
  });
});
