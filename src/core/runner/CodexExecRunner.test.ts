import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppEventBus } from './AppEventBus';
import { CodexExecRunner } from './CodexExecRunner';
import { FileTaskStore } from '../storage/FileTaskStore';

const originalPath = process.env.PATH;

describe('CodexExecRunner', () => {
  beforeEach(() => {
    process.env.PATH = originalPath;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('completes a fake codex run while preserving malformed stdout without false failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-runner-'));
    const fakeBin = path.join(dir, 'bin');
    await fs.mkdir(fakeBin);
    await fs.writeFile(
      path.join(fakeBin, 'codex'),
      [
        '#!/usr/bin/env node',
        'process.stdin.resume();',
        'process.stdout.write(\'{"type":"thread.started"}\\n\');',
        'process.stdout.write(\'{"type":"item.completed","item":{"aggregated_output":"first\');',
        'process.stdout.write(\'\\nsecond","status":"completed"}}\\n\');',
        'process.stdout.write(\'{"type":"turn.completed","status":"completed","message":"done"}\\n\');'
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;

    const store = new FileTaskStore(path.join(dir, 'store'));
    const task = await store.createTask({
      title: 'Fake run',
      prompt: 'Use fake codex.',
      repositoryPath: dir
    });
    const eventBus = new AppEventBus();
    const runner = new CodexExecRunner(store, eventBus);

    const terminal = new Promise<void>((resolve) => {
      eventBus.on((event) => {
        if (event.type === 'run.terminal') {
          resolve();
        }
      });
    });

    await runner.start(task);
    await terminal;

    const snapshot = await store.snapshot();
    const run = snapshot.runs[0];
    expect(run.status).toBe('COMPLETED');
    expect(run.processStatus).toBe('EXITED');
    expect(run.exitCode).toBe(0);
    expect(snapshot.events.some((event) => event.type === 'CODEX_RUN_FAILED')).toBe(false);
    expect(
      snapshot.events.some(
        (event) =>
          event.type === 'CODEX_EVENT_PARSED' && event.payload instanceof Object &&
          'eventType' in event.payload &&
          event.payload.eventType === 'turn.completed'
      )
    ).toBe(true);
  });
});
