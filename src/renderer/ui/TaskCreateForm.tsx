import { useEffect, useState } from 'react';
import type { CreateTaskRequest } from '../../shared/contracts';

interface TaskCreateFormProps {
  defaultRepositoryPath: string;
  disabled?: boolean;
  onCreate(input: CreateTaskRequest): Promise<void>;
}

export function TaskCreateForm({ defaultRepositoryPath, disabled, onCreate }: TaskCreateFormProps) {
  const [title, setTitle] = useState('Summarize this repository');
  const [prompt, setPrompt] = useState(
    'Implement a small, scoped change. Keep edits inside the task worktree and summarize what changed.'
  );
  const [repositoryPath, setRepositoryPath] = useState(defaultRepositoryPath);
  const [testCommand, setTestCommand] = useState('npm test');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setRepositoryPath((current) => current || defaultRepositoryPath);
  }, [defaultRepositoryPath]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      await onCreate({ title, prompt, repositoryPath, testCommand });
      setTitle('');
      setPrompt('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create task.');
    }
  };

  return (
    <form className="task-form" onSubmit={submit}>
      <label>
        <span>Title</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Task title"
          disabled={disabled}
        />
      </label>
      <label>
        <span>Repository</span>
        <input
          value={repositoryPath}
          onChange={(event) => setRepositoryPath(event.target.value)}
          placeholder="/path/to/repository"
          disabled={disabled}
        />
      </label>
      <label>
        <span>Test command</span>
        <input
          value={testCommand}
          onChange={(event) => setTestCommand(event.target.value)}
          placeholder="npm test"
          disabled={disabled}
        />
      </label>
      <label>
        <span>Prompt</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Implementation prompt"
          rows={5}
          disabled={disabled}
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button className="primary-button" type="submit" disabled={disabled}>
        Create task
      </button>
    </form>
  );
}
