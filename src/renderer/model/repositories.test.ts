import { describe, expect, it } from 'vitest';
import type { Task } from '../../shared/contracts';
import type { RepositoryCatalogSnapshot } from '../../shared/repositories';
import {
  buildRepositoryOptions,
  normalizeRepositoryPath,
  resolveRepositorySetupState,
  resolveSelectedRepositoryId,
  tasksForRepository
} from './repositories';

describe('repository selection model', () => {
  it('normalizes trailing separators without losing roots', () => {
    expect(normalizeRepositoryPath('/Users/me/app/')).toBe('/Users/me/app');
    expect(normalizeRepositoryPath('/')).toBe('/');
    expect(normalizeRepositoryPath('C:\\')).toBe('C:\\');
  });

  it('projects core-owned catalog entries without rebuilding path authority', () => {
    const options = buildRepositoryOptions(catalogFixture());

    expect(options).toEqual([
      {
        id: 'repository-current',
        name: 'current',
        displayPath: 'repos/current',
        taskCount: 2,
        isDefault: true,
        available: true
      },
      {
        id: 'repository-other',
        name: 'other',
        displayPath: 'repos/other',
        taskCount: 1,
        isDefault: false,
        available: false
      }
    ]);
  });

  it('filters tasks through authoritative task associations', () => {
    const tasks = [
      taskFixture('one', '/repos/current'),
      taskFixture('two', '/forged/path-that-does-not-control-selection'),
      taskFixture('three', '/repos/current')
    ];

    expect(
      tasksForRepository(tasks, catalogFixture(), 'repository-current').map(
        (task) => task.id
      )
    ).toEqual(['one', 'three']);
    expect(tasksForRepository(tasks, catalogFixture(), '').map((task) => task.id)).toEqual([
      'one',
      'two',
      'three'
    ]);
  });

  it('accepts only a selected id present in the catalog', () => {
    expect(resolveSelectedRepositoryId(catalogFixture())).toBe('repository-current');
    expect(
      resolveSelectedRepositoryId({
        ...catalogFixture(),
        selectedRepositoryId: 'forged-repository'
      })
    ).toBe('');
  });

  it('keeps setup in loading while repositories are still loading', () => {
    expect(
      resolveRepositorySetupState({
        loading: true,
        options: [],
        activeRepositoryId: '',
        firstLaunchSetupCompleted: false
      })
    ).toBe('loading');
  });

  it('requires setup when no repository source is available', () => {
    expect(
      resolveRepositorySetupState({
        loading: false,
        options: [],
        activeRepositoryId: '',
        firstLaunchSetupCompleted: false
      })
    ).toBe('needsRepository');
  });

  it('keeps setup open when a repository exists but setup is incomplete', () => {
    expect(
      resolveRepositorySetupState({
        loading: false,
        options: buildRepositoryOptions(catalogFixture()),
        activeRepositoryId: 'repository-current',
        firstLaunchSetupCompleted: false
      })
    ).toBe('needsReview');
  });

  it('blocks setup when the selected repository is unavailable', () => {
    const catalog = {
      ...catalogFixture(),
      selectedRepositoryId: 'repository-other'
    };
    expect(
      resolveRepositorySetupState({
        loading: false,
        options: buildRepositoryOptions(catalog),
        activeRepositoryId: 'repository-other',
        firstLaunchSetupCompleted: true
      })
    ).toBe('repositoryUnavailable');
  });

  it('treats an active repository as complete after setup is finished', () => {
    expect(
      resolveRepositorySetupState({
        loading: false,
        options: buildRepositoryOptions(catalogFixture()),
        activeRepositoryId: 'repository-current',
        firstLaunchSetupCompleted: true
      })
    ).toBe('complete');
  });
});

function catalogFixture(): RepositoryCatalogSnapshot {
  return {
    revision: 3,
    defaultRepositoryId: 'repository-current',
    selectedRepositoryId: 'repository-current',
    repositories: [
      {
        id: 'repository-current',
        displayName: 'current',
        displayPath: 'repos/current',
        availability: 'AVAILABLE',
        isDefault: true,
        taskCount: 2
      },
      {
        id: 'repository-other',
        displayName: 'other',
        displayPath: 'repos/other',
        availability: 'UNAVAILABLE',
        unavailableReason: 'MISSING',
        isDefault: false,
        taskCount: 1
      }
    ],
    taskAssociations: [
      { taskId: 'one', repositoryId: 'repository-current' },
      { taskId: 'three', repositoryId: 'repository-current' },
      { taskId: 'two', repositoryId: 'repository-other' }
    ]
  };
}

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
