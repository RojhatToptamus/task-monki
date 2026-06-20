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
        <p>Create a read-only Codex run to start collecting evidence.</p>
      </div>
    );
  }

  return (
    <div className="task-list" aria-label="Task cards">
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
            <StatusBadge label="Process" value={task.projection.osProcess} />
            <StatusBadge label="Codex" value={task.projection.codexRun} tone={tone(task)} />
          </div>
        </button>
      ))}
    </div>
  );
}

function tone(task: Task): 'neutral' | 'info' | 'success' | 'warning' | 'error' {
  if (task.projection.health === 'ERROR' || task.projection.health === 'BLOCKED') {
    return 'error';
  }
  if (task.projection.health === 'WARNING') {
    return 'warning';
  }
  if (task.projection.codexRun === 'COMPLETED') {
    return 'success';
  }
  return 'info';
}
