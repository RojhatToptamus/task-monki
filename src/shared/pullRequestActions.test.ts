import { describe, expect, it } from 'vitest';
import { CHECK_LOG_LIMITS, boundCheckLog, holdsUnshippedWork } from './pullRequestActions';

describe('boundCheckLog', () => {
  it('keeps what a terminal shows at the end: a redrawn line at its last draw, and the latest lines past the bound', () => {
    const progress = 'Downloading 10%\rDownloading 55%\rDownloading 100%';
    expect(boundCheckLog(`${progress}\r\n`)).toEqual({ text: 'Downloading 100%', truncated: false });

    const lines = Array.from({ length: CHECK_LOG_LIMITS.lines + 20 }, (_, index) => `step ${index + 1}`);
    // A stack under a plain error is kept: only the platform's own error mark ends a log early.
    const bounded = boundCheckLog([progress, ...lines, 'Error: expected 2, got 3', '    at save (save.js:2:9)', '', ''].join('\n'));
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.split('\n')).toHaveLength(CHECK_LOG_LIMITS.lines);
    expect(bounded.text.split('\n').slice(-2)).toEqual(['Error: expected 2, got 3', '    at save (save.js:2:9)']);

    // A log that marks its error ends there: the cleanup after a failed step is not what failed.
    const actions = boundCheckLog([
      '2026-10-17T14:53:54.9347399Z ##[group]Run node --test',
      '2026-10-17T14:53:54.9599951Z ##[endgroup]',
      'not ok 1 - shouts the greeting',
      '##[error]Process completed with exit code 1.',
      'Post job cleanup.',
      '[command]/usr/bin/git version'
    ].join('\n'));
    // Only earlier lines left out count as truncated: the cleanup after the error is not what the note is about.
    expect(actions).toEqual({ text: 'Run node --test\nnot ok 1 - shouts the greeting\nError: Process completed with exit code 1.', truncated: false });

    // One enormous line is cut to the bound from its end, never left over it.
    const long = boundCheckLog(`${'x'.repeat(CHECK_LOG_LIMITS.chars * 2)}\nlast`);
    expect(long).toEqual({ text: 'last', truncated: true });

    // A credential is redacted before that cut, which would otherwise leave its tail unrecognized.
    const secret = 'SECRET-TOKEN-VALUE';
    const split = boundCheckLog(`${'a'.repeat(5_000)}${secret}${'b'.repeat(CHECK_LOG_LIMITS.chars - 10)}`,
      (text) => text.replaceAll(secret, '[REDACTED]'));
    expect(split.text).toBe(`[REDACTED]${'b'.repeat(CHECK_LOG_LIMITS.chars - 10)}`);

    // A log of megabytes keeps its end, and says earlier lines were left out.
    const huge = boundCheckLog(`${'noise\n'.repeat(400_000)}##[error]The end failed.\nPost job cleanup.`);
    expect(huge.text.split('\n').slice(-1)).toEqual(['Error: The end failed.']);
    expect(huge.truncated).toBe(true);
  });
});

describe('holdsUnshippedWork', () => {
  it('keeps a worktree with work the pull request lacks from merging, and lets a URL push of the pull request head through', () => {
    const head = 'a'.repeat(40);
    expect(holdsUnshippedWork({ status: 'DIRTY', headSha: head }, head)).toBe(true);
    expect(holdsUnshippedWork({ status: 'DIVERGED', headSha: head }, head)).toBe(true);
    expect(holdsUnshippedWork({ status: 'COMMITTED_UNPUSHED', headSha: 'b'.repeat(40) }, head)).toBe(true);
    // Imported work is pushed by URL and has no upstream, so Git calls it unpushed: its head is the pull request's.
    expect(holdsUnshippedWork({ status: 'COMMITTED_UNPUSHED', headSha: head }, head)).toBe(false);
    expect(holdsUnshippedWork({ status: 'COMMITTED_UNPUSHED', headSha: head }, undefined)).toBe(true);
    expect(holdsUnshippedWork({ status: 'PUSHED', headSha: head }, head)).toBe(false);
  });
});
