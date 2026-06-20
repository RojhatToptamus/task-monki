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
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(emptySnapshot);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [defaultRepositoryPath, setDefaultRepositoryPath] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

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
            <h1>Task Manager</h1>
          </div>
          <span className="connection-dot" aria-label="Local runner connected" />
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="sidebar__workspace">
          <TaskCreateForm
            defaultRepositoryPath={defaultRepositoryPath}
            disabled={isLoading || !defaultRepositoryPath}
            onCreate={createTask}
            onRefinePrompt={refinePrompt}
          />

          <section className="task-browser" aria-labelledby="tasks-heading">
            <div className="sidebar__section-title">
              <div>
                <h2 id="tasks-heading">Tasks</h2>
                <span>Select a task to inspect and continue.</span>
              </div>
              <strong>{snapshot.tasks.length}</strong>
            </div>
            <TaskList
              tasks={snapshot.tasks}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
          </section>
        </div>
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
