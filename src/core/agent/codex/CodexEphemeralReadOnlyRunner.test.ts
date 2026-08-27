import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupervisedProcess } from '../../process/ProcessSupervisor';
import {
  buildCodexEphemeralReadOnlyCommand,
  CodexEphemeralRunError,
  superviseCodexEphemeralProcess
} from './CodexEphemeralReadOnlyRunner';

afterEach(() => {
  vi.useRealTimers();
});

describe('CodexEphemeralReadOnlyRunner', () => {
  it('adds only explicit attachment directories and native images to the read-only run', () => {
    const attachmentDirectory = path.resolve('/tmp/staging/draft-1');
    const imagePath = path.resolve(attachmentDirectory, 'screenshot.png');
    const command = buildCodexEphemeralReadOnlyCommand({
      cwd: '/tmp/repository',
      model: 'gpt-test',
      reasoningEffort: 'low',
      configOverrides: [],
      additionalDirectories: [attachmentDirectory, attachmentDirectory],
      imagePaths: [imagePath]
    });

    const scopedArguments = command.argv.slice(command.argv.indexOf('--cd'), -1);
    expect(scopedArguments).toEqual([
      '--cd',
      '/tmp/repository',
      '--add-dir',
      attachmentDirectory,
      '--image',
      imagePath,
      '--model',
      'gpt-test',
      '-c',
      'model_reasoning_effort="low"'
    ]);
    expect(command.argv.filter((value) => value === '--add-dir')).toHaveLength(1);
  });

  it('does not reject a timeout until the child process has been stopped', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter() as SupervisedProcess['events'];
    let releaseCancellation: (() => void) | undefined;
    const cancellationFinished = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationCount = 0;
    const run = superviseCodexEphemeralProcess(
      {
        pid: 123,
        events,
        cancel: async () => {
          cancellationCount += 1;
          await cancellationFinished;
        }
      },
      30
    );
    let resultSettled = false;
    const observedResult = run.result.catch((error: unknown) => error).finally(() => {
      resultSettled = true;
    });

    await vi.advanceTimersByTimeAsync(30);
    expect(cancellationCount).toBe(1);
    expect(resultSettled).toBe(false);

    releaseCancellation?.();
    await Promise.resolve();
    expect(resultSettled).toBe(false);

    events.emit('close', { exitCode: null, signal: 'SIGINT' });
    await expect(observedResult).resolves.toMatchObject({
      code: 'TIMED_OUT'
    } satisfies Partial<CodexEphemeralRunError>);
  });

  it('reports an unconfirmed stop distinctly', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter() as SupervisedProcess['events'];
    const run = superviseCodexEphemeralProcess(
      {
        pid: 123,
        events,
        cancel: () => Promise.reject(new Error('still running'))
      },
      30
    );
    const observedResult = run.result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30);
    await expect(observedResult).resolves.toMatchObject({
      code: 'TERMINATION_UNCONFIRMED'
    } satisfies Partial<CodexEphemeralRunError>);
  });
});
