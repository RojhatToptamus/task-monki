import { useEffect, useState } from 'react';
import type { CreateTaskRequest, RefinePromptResponse } from '../../shared/contracts';

interface TaskCreateFormProps {
  defaultRepositoryPath: string;
  disabled?: boolean;
  onCreate(input: CreateTaskRequest): Promise<void>;
  onRefinePrompt(repositoryPath: string, input: string): Promise<RefinePromptResponse>;
}

export function TaskCreateForm({
  defaultRepositoryPath,
  disabled,
  onCreate,
  onRefinePrompt
}: TaskCreateFormProps) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [repositoryPath, setRepositoryPath] = useState(defaultRepositoryPath);
  const [testCommand, setTestCommand] = useState('npm test');
  const [error, setError] = useState<string | undefined>();
  const [isRefining, setIsRefining] = useState(false);

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

  const refine = async () => {
    setError(undefined);
    setIsRefining(true);
    try {
      const refined = await onRefinePrompt(repositoryPath, prompt);
      setPrompt(refined.prompt);
      setTitle((current) => current || refined.titleSuggestion);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not refine prompt.');
    } finally {
      setIsRefining(false);
    }
  };

  return (
    <form className="task-form" onSubmit={submit}>
      <div className="task-form__intro">
        <div>
          <strong>New task</strong>
          <span>Describe the change and repository target.</span>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={disabled || isRefining || !prompt.trim() || !repositoryPath.trim()}
          onClick={() => void refine()}
        >
          {isRefining ? 'Refining…' : 'Refine prompt'}
        </button>
      </div>
      <label>
        <span>Title</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Add settings validation"
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
          placeholder="Describe the implementation request, constraints, and expected verification."
          rows={5}
          disabled={disabled}
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button
        className="primary-button"
        type="submit"
        disabled={disabled || !title.trim() || !prompt.trim() || !repositoryPath.trim()}
      >
        Create task
      </button>
    </form>
  );
}
