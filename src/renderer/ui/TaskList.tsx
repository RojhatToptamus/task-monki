import type { Task } from '../../shared/contracts';
import { formatShortId } from '../model/selectors';
import { StatusBadge } from './StatusBadge';

interface TaskListProps {
  tasks: Task[];
  selectedTaskId?: string;
  onSelect(taskId: string): void;
}

export function TaskList({ tasks, selectedTaskId, onSelect }: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="empty-state">
        <h2>No tasks yet</h2>
        <p>Create a task to start.</p>
      </div>
    );
  }

  return (
    <div className="task-list" aria-label="Tasks">
      {tasks.map((task) => (
        <button
          key={task.id}
          className={`task-card ${task.id === selectedTaskId ? 'task-card--selected' : ''}`}
          type="button"
          onClick={() => onSelect(task.id)}
        >
          <span className="task-card__meta">#{formatShortId(task.id)}</span>
          <strong>{task.title}</strong>
          <span className="task-card__summary">{task.projection.summary}</span>
          <div className="task-card__badges">
            <StatusBadge label="Flow" value={task.workflowPhase} />
            <StatusBadge label="Git" value={task.projection.git} />
            <StatusBadge label="Tests" value={task.projection.tests} />
            <StatusBadge label="PR" value={task.projection.githubPullRequest} />
          </div>
        </button>
      ))}
    </div>
  );
}
