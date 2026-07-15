import { describe, expect, it } from 'vitest';
import type {
  GitSnapshotRecord,
  RunRecord,
  Task,
  WorktreeRecord
} from './contracts';
import {
  CODEX_REVIEW_DEVELOPER_INSTRUCTIONS,
  TASK_MONKI_CONTEXT_LINE,
  TASK_MONKI_ENGINEERING_QUALITY_CONTRACT,
  TASK_MONKI_PROGRESS_CONTRACT,
  buildContinuationPrompt,
  buildForkAlternativeTaskPrompt,
  buildInitialRunPrompt,
  buildPromptRefinementInstruction,
  buildSteerInstruction
} from './promptTemplates';

describe('prompt templates', () => {
  it('delimits the authoritative task goal in initial implementation prompts', () => {
    const prompt = buildInitialRunPrompt({
      task: taskFixture(),
      worktree: worktreeFixture(),
      settings: { sandbox: 'WORKSPACE_WRITE' },
      readOnlyMode: false
    });

    expect(prompt).toContain(`${TASK_MONKI_CONTEXT_LINE}\n\nAuthoritative Task Monki goal:`);
    expect(prompt).toContain('Authoritative Task Monki goal:\nAdd a progress panel.');
    expect(prompt).toContain('Task Monki progress contract');
    expect(prompt).toContain(TASK_MONKI_ENGINEERING_QUALITY_CONTRACT);
    expect(prompt).toContain('Use 3-6 high-level outcome steps');
    expect(prompt).toContain(
      'Task Monki derives routine read/search/edit/run activity from provider tool telemetry'
    );
    expect(prompt).toContain('write short progress messages beginning with "Progress:"');
    expect(prompt).toContain('Task Monki independently verifies Git, tests, reviews, and delivery');
  });

  it('derives modification guidance from run intent rather than the runtime sandbox label', () => {
    const implementation = buildInitialRunPrompt({
      task: taskFixture(),
      worktree: worktreeFixture(),
      settings: { sandbox: 'DANGER_FULL_ACCESS' },
      readOnlyMode: false
    });
    const analysis = buildInitialRunPrompt({
      task: taskFixture(),
      worktree: worktreeFixture(),
      settings: { sandbox: 'DANGER_FULL_ACCESS' },
      readOnlyMode: true
    });

    expect(implementation).toContain('Only modify files inside this worktree.');
    expect(implementation).not.toContain('Do not modify repository files.');
    expect(analysis).toContain('Do not modify repository files.');
    expect(analysis).not.toContain('Only modify files inside this worktree.');
  });

  it('keeps follow-up and retry turns anchored to the same progress contract', () => {
    const prompt = buildContinuationPrompt({
      task: taskFixture(),
      run: runFixture(),
      gitSnapshot: gitSnapshotFixture(),
      kind: 'continuation',
      instruction: 'Add regression coverage.'
    });

    expect(prompt).toContain('Authoritative Task Monki goal');
    expect(prompt).toContain(TASK_MONKI_CONTEXT_LINE);
    expect(prompt).toContain('Previous run status: FAILED.');
    expect(prompt).toContain('Previous terminal reason: Provider lost the active turn.');
    expect(prompt).toContain('Previous provider final summary excerpt (context only, not verified evidence)');
    expect(prompt).toContain(TASK_MONKI_ENGINEERING_QUALITY_CONTRACT);
    expect(prompt).toContain(TASK_MONKI_PROGRESS_CONTRACT);
    expect(prompt).toContain('Reinspect the current repository state');
  });

  it('includes progress guidance in forked alternatives', () => {
    const prompt = buildForkAlternativeTaskPrompt({
      task: taskFixture(),
      run: runFixture(),
      worktree: worktreeFixture(),
      instruction: 'Try a simpler approach.'
    });

    expect(prompt).toContain('Alternative attempt for this Task Monki goal.');
    expect(prompt).toContain('Authoritative Task Monki goal:\nAdd a progress panel.');
    expect(prompt).toContain('Previous run status: FAILED.');
    expect(prompt).toContain(TASK_MONKI_CONTEXT_LINE);
    expect(prompt).toContain(TASK_MONKI_ENGINEERING_QUALITY_CONTRACT);
    expect(prompt).toContain(TASK_MONKI_PROGRESS_CONTRACT);
  });

  it('wraps active-turn steering with immutable Task Monki constraints', () => {
    const prompt = buildSteerInstruction({
      instruction: 'Focus on the failing test first.',
      worktreePath: '/tmp/task-monki-progress'
    });

    expect(prompt).toContain('Additional instruction for the active Task Monki turn');
    expect(prompt).toContain('Focus on the failing test first.');
    expect(prompt).toContain('Preserve the authoritative task goal');
    expect(prompt).toContain('Current task worktree: /tmp/task-monki-progress');
    expect(prompt).toContain('Do not commit, push, merge');
  });

  it('asks prompt refinement to derive verification from inspected repo commands', () => {
    const prompt = buildPromptRefinementInstruction('Add sync badges.');

    expect(prompt).toContain('Verification must name concrete commands');
    expect(prompt).toContain('repository docs, package scripts, or nearby test conventions');
    expect(prompt).toContain('instead of inventing one');
  });

  it('keeps engineering quality guidance focused on source-of-truth fixes and honest verification', () => {
    expect(TASK_MONKI_ENGINEERING_QUALITY_CONTRACT).toContain(
      'Before editing, inspect the relevant code, tests, and nearby patterns'
    );
    expect(TASK_MONKI_ENGINEERING_QUALITY_CONTRACT).toContain(
      'Fix the smallest underlying cause that preserves the existing design'
    );
    expect(TASK_MONKI_ENGINEERING_QUALITY_CONTRACT).toContain(
      'Do not claim tests, builds, checks, commits, pushes, reviews, or delivery succeeded unless you actually performed or observed them'
    );
  });

  it('asks review runs for concise interim progress without changing final output shape', () => {
    expect(CODEX_REVIEW_DEVELOPER_INSTRUCTIONS).toContain(TASK_MONKI_CONTEXT_LINE);
    expect(CODEX_REVIEW_DEVELOPER_INSTRUCTIONS).not.toContain(
      TASK_MONKI_ENGINEERING_QUALITY_CONTRACT
    );
    expect(CODEX_REVIEW_DEVELOPER_INSTRUCTIONS).toContain(
      'progress messages beginning with "Progress:"'
    );
    expect(CODEX_REVIEW_DEVELOPER_INSTRUCTIONS).toContain(
      'Inspecting changed files for regressions'
    );
    expect(CODEX_REVIEW_DEVELOPER_INSTRUCTIONS).toContain(
      'Do not include these Progress lines in the final review output'
    );
    expect(CODEX_REVIEW_DEVELOPER_INSTRUCTIONS).toContain(
      'exactly one fenced JSON block'
    );
  });
});

function taskFixture(): Task {
  return {
    id: 'task-1',
    prompt: 'Add a progress panel.',
    title: 'Progress panel'
  } as Task;
}

function worktreeFixture(): WorktreeRecord {
  return {
    id: 'worktree-1',
    worktreePath: '/tmp/task-monki-progress'
  } as WorktreeRecord;
}

function runFixture(): RunRecord {
  return {
    id: 'run-1',
    status: 'FAILED',
    recoveryState: 'REQUIRES_USER_ACTION',
    terminalReason: 'Provider lost the active turn.',
    finalMessage: 'I inspected the renderer and found the progress panel update was incomplete.'
  } as RunRecord;
}

function gitSnapshotFixture(): GitSnapshotRecord {
  return {
    id: 'git-1',
    status: 'DIRTY',
    headSha: 'abc123',
    dirtyFingerprint: 'fingerprint',
    worktreePath: '/tmp/task-monki-progress'
  } as GitSnapshotRecord;
}
