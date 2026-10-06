import { describe, expect, it } from 'vitest';
import type { ApplicationPreviewInstance } from '../../shared/applicationPreview';
import { applicationPreviewStatus } from './applicationPreviewStatus';
import { visiblePreviewInstances } from './previewInstances';

const serving: ApplicationPreviewInstance = {
  taskId: 'task-a', worktreeId: 'worktree-a', isCurrentWorktree: true, title: 'Stock alerts', kind: 'task', repositoryName: 'Inventory',
  branch: 'feature/alerts', projectDirectory: '/worktrees/inventory', approvalPending: false,
  status: {
    name: 'application-a', busy: false,
    active: { id: 'previous', type: 'command', state: 'ready', startedAt: '', sources: [] },
    latest: { id: 'update', type: 'command', state: 'failed', startedAt: '', sources: [] }
  }
};

describe('preview instance state', () => {
  it('keeps a failed replacement active and needing attention without claiming the new app is serving', () => {
    expect(applicationPreviewStatus(serving.status)).toMatchObject({
      label: 'Update failed', note: 'Previous attempt serving', active: true, needsAttention: true
    });
    const failed = { ...serving, taskId: 'task-b', status: { ...serving.status, active: undefined } };
    expect(applicationPreviewStatus(failed.status)).toMatchObject({
      label: 'Startup failed', note: 'Not serving', active: false, needsAttention: true
    });
    expect(visiblePreviewInstances([serving, failed], '', 'active').map(value => value.taskId)).toEqual(['task-a']);
    expect(visiblePreviewInstances([serving, failed], '', 'inactive').map(value => value.taskId)).toEqual(['task-b']);
    expect(visiblePreviewInstances([serving, failed], '', 'attention')).toHaveLength(2);
    expect(visiblePreviewInstances([serving], '  FEATURE/ALERTS  ', 'all')).toHaveLength(1);
    expect(visiblePreviewInstances([serving], 'not-a-worktree', 'all')).toHaveLength(0);
  });

  it('prioritizes required cleanup and approval over a serving app or pending replacement', () => {
    const pending = { ...serving.status, candidate: { ...serving.status.latest!, state: 'starting' as const } };
    expect(applicationPreviewStatus(pending, true).label).toBe('Approval required');
    expect(applicationPreviewStatus({ ...pending, cleanup: [{ attemptId: 'update', sources: [], error: { code: 'CLEANUP_INCOMPLETE', message: 'Process did not exit' } }] }, true).label).toBe('Cleanup required');
    expect(applicationPreviewStatus(pending).label).toBe('Updating');
    expect(applicationPreviewStatus({ name: 'retained', busy: false, data: { running: false, resources: [{ name: 'db', type: 'postgres' }] } })).toMatchObject({ label: 'Stopped', active: false });
  });
});
