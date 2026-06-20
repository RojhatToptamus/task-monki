import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CreateTaskRequest, TaskSnapshot, WorkflowPhase } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import {
  selectActiveRun,
  selectCurrentWorktree,
  selectLatestGitSnapshot,
  selectLatestGitHubRepository,
  selectLatestBranchPublication,
  selectLatestPullRequest,
  selectLatestCiRollup,
  selectLatestReviewRollup,
  selectLatestMergeSnapshot,
  selectLatestTestRun,
  selectTaskEvents,
  selectTaskRuns
} from '../model/selectors';
import { TaskCreateForm } from './TaskCreateForm';
import { TaskDetail } from './TaskDetail';
import { TaskList } from './TaskList';

type ThemePreference = 'system' | 'midnight' | 'porcelain' | 'sage';

const themeStorageKey = 'task-manager.theme.v1';
const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'porcelain', label: 'Porcelain' },
  { value: 'sage', label: 'Sage' }
];

function readThemePreference(): ThemePreference {
  const stored = window.localStorage.getItem(themeStorageKey);
  return themeOptions.some((option) => option.value === stored)
    ? (stored as ThemePreference)
    : 'system';
}

const emptySnapshot: TaskSnapshot = {
  tasks: [],
  iterations: [],
  worktrees: [],
  gitSnapshots: [],
  testRuns: [],
  githubRepositories: [],
  branchPublications: [],
  pullRequests: [],
  ciRollups: [],
  reviewRollups: [],
  mergeSnapshots: [],
  runs: [],
  events: [],
  artifacts: []
};

export function App() {
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(emptySnapshot);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [defaultRepositoryPath, setDefaultRepositoryPath] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      delete root.dataset.theme;
      window.localStorage.removeItem(themeStorageKey);
    } else {
      root.dataset.theme = theme;
      window.localStorage.setItem(themeStorageKey, theme);
    }
  }, [theme]);

  const refresh = useCallback(async () => {
    const next = await taskManagerApi.listTasks();
    setSnapshot(next);
    setSelectedTaskId((current) => current ?? next.tasks[0]?.id);
  }, []);

  useEffect(() => {
    let canceled = false;

    async function load() {
      try {
        const [repoPath] = await Promise.all([
          taskManagerApi.getDefaultRepositoryPath(),
          refresh()
        ]);
        if (!canceled) {
          setDefaultRepositoryPath(repoPath);
        }
      } catch (caught) {
        if (!canceled) {
          setError(caught instanceof Error ? caught.message : 'Failed to load application state.');
        }
      } finally {
        if (!canceled) {
          setIsLoading(false);
        }
      }
    }

    void load();
    return () => {
      canceled = true;
    };
  }, [refresh]);

  useEffect(() => {
    return taskManagerApi.onUpdate(() => {
      void refresh();
    });
  }, [refresh]);

  const selectedTask = snapshot.tasks.find((task) => task.id === selectedTaskId);
  const selectedRuns = useMemo(
    () => (selectedTask ? selectTaskRuns(snapshot, selectedTask.id) : []),
    [selectedTask, snapshot]
  );
  const selectedRun = selectedTask ? selectActiveRun(selectedTask, selectedRuns) : undefined;
  const selectedEvents = useMemo(
    () => (selectedTask ? selectTaskEvents(snapshot, selectedTask.id) : []),
    [selectedTask, snapshot]
  );
  const selectedWorktree = selectedTask ? selectCurrentWorktree(snapshot, selectedTask) : undefined;
  const selectedGitSnapshot = selectedTask
    ? selectLatestGitSnapshot(snapshot, selectedTask)
    : undefined;
  const selectedTestRun = selectedTask ? selectLatestTestRun(snapshot, selectedTask) : undefined;
  const selectedGitHubRepository = selectedTask
    ? selectLatestGitHubRepository(snapshot, selectedTask)
    : undefined;
  const selectedBranchPublication = selectedTask
    ? selectLatestBranchPublication(snapshot, selectedTask)
    : undefined;
  const selectedPullRequest = selectedTask ? selectLatestPullRequest(snapshot, selectedTask) : undefined;
  const selectedCiRollup = selectedTask ? selectLatestCiRollup(snapshot, selectedTask) : undefined;
  const selectedReviewRollup = selectedTask ? selectLatestReviewRollup(snapshot, selectedTask) : undefined;
  const selectedMergeSnapshot = selectedTask ? selectLatestMergeSnapshot(snapshot, selectedTask) : undefined;

  const createTask = async (input: CreateTaskRequest) => {
    const created = await taskManagerApi.createTask(input);
    setSelectedTaskId(created.id);
    await refresh();
  };

  const refinePrompt = async (repositoryPath: string, input: string) => {
    return taskManagerApi.refinePrompt({ repositoryPath, input });
  };

  const startRun = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.startRun({ taskId, mode: 'IMPLEMENTATION' });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to start run.');
    }
  };

  const prepareWorktree = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.prepareWorktree({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to prepare worktree.');
    }
  };

  const refreshEvidence = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.refreshEvidence({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to refresh evidence.');
    }
  };

  const runTests = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.runTests({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to run tests.');
    }
  };

  const createDeliveryCommit = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.createDeliveryCommit({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create delivery commit.');
    }
  };

  const preflightGitHub = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.preflightGitHub({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to check GitHub capability.');
    }
  };

  const createPullRequest = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.createPullRequest({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create pull request.');
    }
  };

  const refreshGitHub = async (taskId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.refreshGitHub({ taskId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to refresh GitHub.');
    }
  };

  const transitionTask = async (taskId: string, toPhase: WorkflowPhase) => {
    setError(undefined);
    try {
      await taskManagerApi.transitionTask({ taskId, toPhase });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Transition blocked.');
    }
  };

  const cancelRun = async (runId: string) => {
    setError(undefined);
    try {
      await taskManagerApi.cancelRun({ runId });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to cancel run.');
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="sidebar__header">
          <div>
            <span className="app-kicker">Phase 2</span>
            <h1>Task Manager</h1>
          </div>
          <div className="sidebar__controls">
            <label className="theme-picker">
              <span>Theme</span>
              <select
                aria-label="Theme"
                value={theme}
                onChange={(event) => setTheme(event.target.value as ThemePreference)}
              >
                {themeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="connection-dot" aria-label="Local runner connected" />
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <TaskCreateForm
          defaultRepositoryPath={defaultRepositoryPath}
          disabled={isLoading || !defaultRepositoryPath}
          onCreate={createTask}
          onRefinePrompt={refinePrompt}
        />

        <div className="sidebar__section-title">
          <span>Task cards</span>
          <strong>{snapshot.tasks.length}</strong>
        </div>
        <TaskList
          tasks={snapshot.tasks}
          selectedTaskId={selectedTaskId}
          onSelect={setSelectedTaskId}
        />
      </aside>

      <TaskDetail
        task={selectedTask}
        run={selectedRun}
        worktree={selectedWorktree}
        gitSnapshot={selectedGitSnapshot}
        testRun={selectedTestRun}
        githubRepository={selectedGitHubRepository}
        branchPublication={selectedBranchPublication}
        pullRequest={selectedPullRequest}
        ciRollup={selectedCiRollup}
        reviewRollup={selectedReviewRollup}
        mergeSnapshot={selectedMergeSnapshot}
        events={selectedEvents}
        artifacts={snapshot.artifacts}
        onPrepareWorktree={prepareWorktree}
        onStart={startRun}
        onCancel={cancelRun}
        onRefreshEvidence={refreshEvidence}
        onRunTests={runTests}
        onCreateDeliveryCommit={createDeliveryCommit}
        onPreflightGitHub={preflightGitHub}
        onCreatePullRequest={createPullRequest}
        onRefreshGitHub={refreshGitHub}
        onTransition={transitionTask}
      />
    </div>
  );
}
