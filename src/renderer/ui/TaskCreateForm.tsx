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
    'Summarize the repository files, identify the current project state, and do not modify anything.'
  );
  const [repositoryPath, setRepositoryPath] = useState(defaultRepositoryPath);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setRepositoryPath((current) => current || defaultRepositoryPath);
  }, [defaultRepositoryPath]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      await onCreate({ title, prompt, repositoryPath });
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
        <span>Prompt</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Read-only Codex prompt"
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
