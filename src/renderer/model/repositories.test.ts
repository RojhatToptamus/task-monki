import { describe, expect, it } from 'vitest';
import type { Repository, Task } from '../../shared/contracts';
import {
  buildRepositoryOptions,
  filterRepositoryOptions,
  resolveRepositorySetupState,
  resolveSelectedRepositoryId
} from './repositories';

describe('repository selection model', () => {
  it('builds options from durable repositories and counts tasks by ID', () => {
    const options = buildRepositoryOptions({
      repositories: [
        repositoryFixture('repo-current', '/repos/current'),
        repositoryFixture('repo-empty', '/repos/empty')
      ],
      tasks: [
        taskFixture('one', 'repo-current'),
        taskFixture('two', 'repo-current')
      ]
    });

    expect(options).toEqual([
      expect.objectContaining({
        id: 'repo-current',
        path: '/repos/current',
        displayPath: '/repos/current',
        taskCount: 2
      }),
      expect.objectContaining({ id: 'repo-empty', taskCount: 0 })
    ]);
  });

  it('keeps repositories with identical folder names distinguishable', () => {
    const options = buildRepositoryOptions({
      repositories: [
        repositoryFixture('repo-one', '/Users/one/work/project'),
        repositoryFixture('repo-two', '/Volumes/two/work/project')
      ],
      tasks: []
    });

    expect(options.map((option) => option.displayPath)).toEqual([
      '…/one/work/project',
      '…/two/work/project'
    ]);
  });

  it('filters by repository name or full path without changing the options', () => {
    const options = buildRepositoryOptions({
      repositories: [
        repositoryFixture('primary', '/Users/dev/primary'),
        repositoryFixture('secondary', '/Volumes/work/repo-secondary')
      ],
      tasks: []
    });

    expect(filterRepositoryOptions(options, 'SECONDARY').map((option) => option.id)).toEqual([
      'secondary'
    ]);
    expect(filterRepositoryOptions(options, '/users/dev').map((option) => option.id)).toEqual([
      'primary'
    ]);
    expect(filterRepositoryOptions(options, '')).toEqual(options);
  });

  it('keeps a selected ID and falls back to the first available repository', () => {
    const options = buildRepositoryOptions({
      repositories: [
        repositoryFixture('missing', '/repos/missing', 'MISSING'),
        repositoryFixture('available', '/repos/current')
      ],
      tasks: []
    });

    expect(resolveSelectedRepositoryId(options, 'missing')).toBe('missing');
    expect(resolveSelectedRepositoryId(options, 'unknown')).toBe('available');
  });

  it.each([
    [true, [], '', false, 'loading'],
    [false, [], '', false, 'needsRepository'],
    [false, [repositoryFixture('repo', '/repo')], 'repo', false, 'needsReview'],
    [false, [repositoryFixture('repo', '/repo')], 'repo', true, 'complete']
  ] as const)(
    'resolves setup state without a second repository source',
    (loading, repositories, activeRepositoryId, firstLaunchSetupCompleted, expected) => {
      expect(
        resolveRepositorySetupState({
          loading,
          options: buildRepositoryOptions({ repositories: [...repositories], tasks: [] }),
          activeRepositoryId,
          firstLaunchSetupCompleted
        })
      ).toBe(expected);
    }
  );
});

function repositoryFixture(
  id: string,
  repositoryPath: string,
  status: Repository['status'] = 'AVAILABLE'
): Repository {
  return {
    id,
    name: repositoryPath.split('/').at(-1) ?? id,
    path: repositoryPath,
    status,
    remotes: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function taskFixture(id: string, repositoryId: string): Task {
  return {
    id,
    title: id,
    prompt: 'Do the work.',
    repositoryId,
    workflowPhase: 'READY',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
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
