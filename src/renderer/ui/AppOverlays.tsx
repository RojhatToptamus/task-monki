import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  BOARD_COLORS,
  type Board,
  type BoardColor,
  type CreateBoardRequest,
  type DeleteTaskResult,
  type GitSnapshotRecord,
  type Repository,
  type RepositoryImpact,
  type Task,
  type WorkflowPhase,
  type WorktreeRecord
} from '../../shared/contracts';
import type { RepositoryOption } from '../model/repositories';
import { formatShortId } from '../model/selectors';
import { ImpactList } from './ImpactList';
import { RepositoryPicker } from './RepositoryPicker';
import { useDialogFocusBoundary } from './dialogFocus';

export type NotificationTone = 'info' | 'success' | 'error';

export interface AppNotification {
  id: string;
  tone: NotificationTone;
  message: string;
}

const BOARD_PHASE_OPTIONS: ReadonlyArray<{ value: WorkflowPhase; label: string }> = [
  { value: 'BACKLOG', label: 'Backlog' },
  { value: 'READY', label: 'Ready' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'REVIEW', label: 'Review' },
  { value: 'IN_REVIEW', label: 'In review' },
  { value: 'DONE', label: 'Done' },
  { value: 'BLOCKED', label: 'Blocked' },
  { value: 'CANCELED', label: 'Canceled' },
  { value: 'ARCHIVED', label: 'Archived' }
];

const BOARD_COLOR_LABELS: Record<BoardColor, string> = {
  NEUTRAL: 'Neutral',
  BLUE: 'Blue',
  AMBER: 'Amber',
  GREEN: 'Green',
  ROSE: 'Rose',
  VIOLET: 'Violet'
};

export function BoardEditorModal({
  board,
  repositories,
  onCancel,
  onSave,
  onDelete,
  fallbackReturnFocusRef
}: {
  board?: Board;
  repositories: RepositoryOption[];
  onCancel(): void;
  onSave(input: CreateBoardRequest): Promise<void>;
  onDelete(boardId: string): Promise<void>;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [name, setName] = useState(board?.name ?? '');
  const [color, setColor] = useState<BoardColor>(board?.color ?? 'NEUTRAL');
  const [repositoryIds, setRepositoryIds] = useState<string[]>(board?.repositoryIds ?? []);
  const [workflowPhases, setWorkflowPhases] = useState<WorkflowPhase[]>(
    board?.workflowPhases ?? []
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const panelRef = useRef<HTMLFormElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: nameInputRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });

  const toggleWorkflowPhase = (workflowPhase: WorkflowPhase) => {
    setWorkflowPhases((current) =>
      current.includes(workflowPhase)
        ? current.filter((candidate) => candidate !== workflowPhase)
        : [...current, workflowPhase]
    );
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter a name for this saved view.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onSave({ name, color, repositoryIds, workflowPhases });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this view.');
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!board) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDelete(board.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete this view.');
      setBusy(false);
    }
  };

  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="board-editor-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <form
        ref={panelRef}
        className="tm-modal__panel tm-board-editor"
        tabIndex={-1}
        onSubmit={submit}
      >
        <h3 id="board-editor-title">{board ? 'Edit saved view' : 'New saved view'}</h3>

        <label className="field">
          <span>Name</span>
          <input
            ref={nameInputRef}
            value={name}
            maxLength={80}
            placeholder="For example, Review across repositories"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <fieldset className="tm-board-editor__color">
          <legend>Color</legend>
          <div className="tm-board-editor__swatches">
            {BOARD_COLORS.map((option) => (
              <label
                className="tm-board-editor__swatch"
                key={option}
                title={BOARD_COLOR_LABELS[option]}
              >
                <input
                  type="radio"
                  name="saved-view-color"
                  value={option}
                  checked={color === option}
                  disabled={busy}
                  aria-label={`${BOARD_COLOR_LABELS[option]} saved-view color`}
                  onChange={() => setColor(option)}
                />
                <span
                  className="tm-board-color"
                  data-board-color={option.toLowerCase()}
                  aria-hidden="true"
                />
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="tm-board-editor__filter">
          <legend>Repositories</legend>
          <div className="tm-board-editor__filter-head">
            <small>
              {repositoryIds.length === 0 ? 'All repositories' : `${repositoryIds.length} selected`}
            </small>
            {repositoryIds.length > 0 ? (
              <button type="button" disabled={busy} onClick={() => setRepositoryIds([])}>
                Use all
              </button>
            ) : null}
          </div>
          <RepositoryPicker
            options={repositories}
            selectedIds={repositoryIds}
            disabled={busy}
            ariaLabel="Saved-view repositories"
            onChange={setRepositoryIds}
          />
        </fieldset>

        <fieldset className="tm-board-editor__filter">
          <legend>Workflow phases</legend>
          <div className="tm-board-editor__filter-head">
            <small>
              {workflowPhases.length === 0 ? 'All workflow phases' : `${workflowPhases.length} selected`}
            </small>
            {workflowPhases.length > 0 ? (
              <button type="button" disabled={busy} onClick={() => setWorkflowPhases([])}>
                Use all
              </button>
            ) : null}
          </div>
          <div className="tm-board-editor__options tm-board-editor__options--phases">
            {BOARD_PHASE_OPTIONS.map((option) => (
              <label key={option.value} className="tm-board-editor__option">
                <input
                  type="checkbox"
                  checked={workflowPhases.includes(option.value)}
                  disabled={busy}
                  onChange={() => toggleWorkflowPhase(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {error ? <div className="tm-error tm-board-editor__error">{error}</div> : null}
        <div className="tm-modal__actions tm-board-editor__actions">
          {board ? (
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete view
            </button>
          ) : null}
          <span className="tm-board-editor__actions-spacer" />
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Saving…' : 'Save view'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function GlobalNotifier({ notifications }: { notifications: AppNotification[] }) {
  return (
    <div className="tm-notifier" aria-live="polite" aria-atomic="false">
      {notifications.map((notification) => (
        <div
          className={`tm-notifier__item tm-notifier__item--${notification.tone}`}
          key={notification.id}
        >
          <span className="tm-notifier__dot" />
          <strong>{notification.message}</strong>
        </div>
      ))}
    </div>
  );
}

export function RepositoryDisconnectModal({
  repository,
  impact,
  onCancel,
  onConfirm,
  fallbackReturnFocusRef
}: {
  repository: Repository;
  impact: RepositoryImpact;
  onCancel(): void;
  onConfirm(): Promise<void>;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: cancelRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });
  const submit = async () => {
    if (impact.blockingReason) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="tm-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="disconnect-repository-title"
    >
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <div
        ref={panelRef}
        className="tm-modal__panel tm-delete-modal"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="disconnect-repository-title">Disconnect {repository.name}?</h3>
        <p>
          Tasks, worktrees, branches, commits, reviews, and delivery evidence stay intact. Task
          actions that need this checkout remain unavailable until it is reconnected.
        </p>
        <ImpactList
          ariaLabel="Repository disconnect impact"
          groups={[
            {
              kind: 'untouched',
              items: [
                `${impact.taskCount} tasks`,
                `${impact.worktreeCount} worktrees`,
                `${impact.openPullRequestCount} open pull requests`
              ]
            }
          ]}
        />
        {impact.blockingReason ? <div className="tm-error">{impact.blockingReason}</div> : null}
        <div className="tm-modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="outline-button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={busy || Boolean(impact.blockingReason)}
            onClick={() => void submit()}
          >
            {busy ? 'Disconnecting…' : 'Disconnect repository'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeleteTaskModal({
  task,
  worktree,
  gitSnapshot,
  onCancel,
  onConfirm,
  fallbackReturnFocusRef
}: {
  task: Task;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  onCancel(): void;
  onConfirm(removeWorktree: boolean): Promise<DeleteTaskResult>;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [removeWorktree, setRemoveWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const worktreeRemoval = describeWorktreeRemoval(worktree, gitSnapshot);
  const canRemoveWorktree = worktreeRemoval.status === 'available';

  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: cancelRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });

  useEffect(() => {
    setRemoveWorktree(false);
    setBusy(false);
  }, [task.id]);

  useEffect(() => {
    if (!canRemoveWorktree) {
      setRemoveWorktree(false);
    }
  }, [canRemoveWorktree]);

  const submit = () => {
    setBusy(true);
    void onConfirm(removeWorktree).catch(() => {
      setBusy(false);
    });
  };

  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-task-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <div ref={panelRef} className="tm-modal__panel tm-delete-modal" tabIndex={-1}>
        <div className="tm-delete-modal__head">
          <span className="tm-delete-modal__mark" aria-hidden="true">
            <TrashIcon />
          </span>
          <div>
            <h3 id="delete-task-title">Delete task #{formatShortId(task.id)}</h3>
            <p>
              Removes this task, its Task Monki records, and managed attachments. Provider
              history and external protocol-journal traces may remain.
            </p>
          </div>
        </div>

        <ImpactList
          ariaLabel="Task deletion impact"
          groups={[
            {
              kind: 'deleted',
              items: [
                'Task record and workflow state',
                'Local run, event, and session records',
                'Managed attachments, artifacts, and evidence records'
              ]
            },
            {
              kind: 'kept',
              items: [
                'Repository and Git history',
                'Remote branch, PR, and commits',
                'Fork alternatives and source tasks',
                'Provider history and external protocol-journal traces'
              ]
            }
          ]}
        />

        <label
          className={`tm-delete-modal__worktree ${
            canRemoveWorktree ? '' : 'tm-delete-modal__worktree--disabled'
          } ${worktreeRemoval.status === 'dirty' ? 'tm-delete-modal__worktree--blocked' : ''}`}
        >
          <input
            type="checkbox"
            checked={removeWorktree}
            disabled={!canRemoveWorktree || busy}
            onChange={(event) => setRemoveWorktree(event.target.checked)}
          />
          <span>
            <strong>Also remove local worktree</strong>
            <small>{worktreeRemoval.detail}</small>
          </span>
        </label>

        <div className="tm-modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="outline-button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="danger-button" disabled={busy} onClick={submit}>
            {busy ? 'Deleting…' : 'Delete task'}
          </button>
        </div>
      </div>
    </div>
  );
}

function describeWorktreeRemoval(
  worktree: WorktreeRecord | undefined,
  gitSnapshot: GitSnapshotRecord | undefined
): { status: 'available' | 'none' | 'unverified' | 'dirty' | 'unavailable'; detail: string } {
  if (!worktree) {
    return {
      status: 'none',
      detail: 'No local worktree is recorded for this task.'
    };
  }
  if (worktree.status === 'MISSING' || worktree.status === 'REMOVED') {
    return {
      status: 'none',
      detail: 'No removable local worktree exists for this task.'
    };
  }
  if (worktree.status !== 'PRESENT') {
    return {
      status: 'unavailable',
      detail:
        `The local worktree is ${worktree.status.toLowerCase().replace(/_/g, ' ')}. ` +
        'Repair or refresh it before removal.'
    };
  }
  if (!gitSnapshot) {
    return {
      status: 'unverified',
      detail: 'Refresh Git evidence before removing the local worktree.'
    };
  }

  const dirtyCount =
    gitSnapshot.stagedCount +
    gitSnapshot.unstagedCount +
    gitSnapshot.untrackedCount +
    gitSnapshot.conflictedCount;
  if (dirtyCount > 0 || gitSnapshot.status === 'DIRTY' || gitSnapshot.status === 'CONFLICTED') {
    return {
      status: 'dirty',
      detail:
        'The worktree has uncommitted, untracked, or conflicted files. Commit, stash, or clean it before removal.'
    };
  }

  return {
    status: 'available',
    detail: `${worktree.worktreePath} will be removed from disk.`
  };
}

function TrashIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </svg>
  );
}
