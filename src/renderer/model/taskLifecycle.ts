import { BOARD_COLUMNS, describeTaskStatus, isTaskWorkInFlight, type TaskCardSource } from './taskView';
import type { Tone } from './viewTypes';

export interface TaskLifecycleStep {
  key: string;
  /** The stage's name; always the same four words, so the path reads the same on every task. */
  label: string;
  state: 'done' | 'current' | 'upcoming';
  /** At the task's position: its status word and tone, exactly as the board card shows them. */
  status?: { label: string; tone: Tone };
  /** At the task's position: an agent run or review is working right now. */
  inFlight?: boolean;
}

const STAGE_NAMES: Record<string, string> = {
  ready: 'Ready',
  progress: 'In progress',
  review: 'Review',
  done: 'Done'
};

/** Phases that share a lane but are not its stage: the lane's word would misname them. */
const OWN_STAGE_NAMES: Partial<Record<TaskCardSource['workflowPhase'], string>> = {
  BACKLOG: 'Backlog',
  CANCELED: 'Canceled',
  ARCHIVED: 'Archived'
};

/**
 * The board's lanes as one task's path, in the lanes' own words, except where
 * the task's phase is not the lane's stage (a backlog item, a canceled or
 * archived task). The precise state is carried at the task's position as a
 * tone, not a second name; the Overview's Now panel says it in words.
 */
export function describeTaskLifecycle(task: TaskCardSource): TaskLifecycleStep[] {
  const current = BOARD_COLUMNS.findIndex((column) => column.phases.includes(task.workflowPhase));
  return BOARD_COLUMNS.map((column, index) =>
    index === current
      ? {
          key: column.key,
          label: OWN_STAGE_NAMES[task.workflowPhase] ?? STAGE_NAMES[column.key] ?? column.label,
          state: 'current' as const,
          status: describeTaskStatus(task),
          inFlight: isTaskWorkInFlight(task)
        }
      : {
          key: column.key,
          label: STAGE_NAMES[column.key] ?? column.label,
          state: index < current ? ('done' as const) : ('upcoming' as const)
        }
  );
}
