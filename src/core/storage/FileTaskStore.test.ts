import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodexExecCommand } from '../codex/commandBuilder';
import { FileTaskStore } from './FileTaskStore';

describe('FileTaskStore', () => {
  it('persists tasks, runs, events, and artifacts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Read repo',
      prompt: 'Summarize and do not write.',
      repositoryPath: dir
    });
    const run = await store.createRun(
      task,
      buildCodexExecCommand({ repositoryPath: dir, sandboxMode: 'read-only' })
    );

    await store.appendArtifact(run.stdoutArtifactId, '{"type":"turn.started"}\n');
    const final = await store.writeFinalArtifact(task.id, run.id, '# Final\n');

    const reloaded = new FileTaskStore(dir);
    const snapshot = await reloaded.snapshot();

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.events.some((event) => event.type === 'TASK_CREATED')).toBe(true);
    expect(snapshot.artifacts.some((artifact) => artifact.id === final.id)).toBe(true);
    await expect(reloaded.readArtifact(final.id)).resolves.toBe('# Final\n');
  });
});
