import { describe, expect, it } from 'vitest';
import type { Task } from '../../shared/contracts';
import {
  buildRepositoryOptions,
  mergeRepositoryPath,
  normalizeRepositoryPath,
  resolveSelectedRepositoryPath,
  tasksForRepository
} from './repositories';

describe('repository selection model', () => {
  it('normalizes trailing separators without losing roots', () => {
    expect(normalizeRepositoryPath('/Users/me/app/')).toBe('/Users/me/app');
    expect(normalizeRepositoryPath('/')).toBe('/');
    expect(normalizeRepositoryPath('C:\\')).toBe('C:\\');
  });

  it('builds unique repository options from defaults, saved paths, and tasks', () => {
    const options = buildRepositoryOptions({
      defaultRepositoryPath: '/repos/current/',
      storedRepositoryPaths: ['/repos/empty', '/repos/current'],
      tasks: [
        taskFixture('one', '/repos/current'),
        taskFixture('two', '/repos/current/'),
        taskFixture('three', '/repos/other')
      ]
    });

    expect(options.map((option) => option.path)).toEqual([
      '/repos/current',
      '/repos/empty',
      '/repos/other'
    ]);
    expect(options[0]).toMatchObject({
      displayPath: 'repos/current',
      isDefault: true,
      taskCount: 2
    });
    expect(options[1]).toMatchObject({
      path: '/repos/empty',
      taskCount: 0
    });
  });

  it('filters tasks to the selected repository', () => {
    const tasks = [
      taskFixture('one', '/repos/current'),
      taskFixture('two', '/repos/other'),
      taskFixture('three', '/repos/current/')
    ];

    expect(tasksForRepository(tasks, '/repos/current').map((task) => task.id)).toEqual([
      'one',
      'three'
    ]);
    expect(tasksForRepository(tasks, '').map((task) => task.id)).toEqual([
      'one',
      'two',
      'three'
    ]);
  });

  it('resolves and merges selected repository paths', () => {
    const options = buildRepositoryOptions({
      defaultRepositoryPath: '/repos/current',
      storedRepositoryPaths: ['/repos/empty'],
      tasks: []
    });

    expect(resolveSelectedRepositoryPath(options, '/repos/empty/')).toBe('/repos/empty');
    expect(resolveSelectedRepositoryPath(options, '/repos/missing')).toBe('/repos/current');
    expect(mergeRepositoryPath(['/repos/current'], '/repos/current/')).toEqual([
      '/repos/current'
    ]);
    expect(mergeRepositoryPath(['/repos/current'], '/repos/other')).toEqual([
      '/repos/current',
      '/repos/other'
    ]);
  });
});

function taskFixture(id: string, repositoryPath: string): Task {
  return {
    id,
    title: id,
    prompt: 'Do the work.',
    repositoryPath,
    workflowPhase: 'READY',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    testCommand: 'npm test',
    agentSettings: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    projection: {
      requestedAction: 'NONE',
      agentRun: 'IDLE',
      osProcess: 'UNKNOWN',
      repositoryPreflight: 'UNKNOWN',
      worktree: 'NOT_CREATED',
      git: 'NOT_INSPECTED',
      tests: 'NOT_RUN',
      githubRepository: 'NOT_CHECKED',
      branchPublication: 'NOT_PUSHED',
      githubPullRequest: 'UNLINKED',
      ciChecks: 'NOT_APPLICABLE',
      reviews: 'NOT_APPLICABLE',
      codexReview: { status: 'NOT_RUN' },
      merge: 'NOT_APPLICABLE',
      artifact: 'NONE',
      health: 'HEALTHY',
      summary: 'Ready.',
      findings: [],
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  };
}
