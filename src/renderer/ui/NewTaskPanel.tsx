import { useEffect, useState } from 'react';
import type { CreateTaskRequest, RefinePromptResponse } from '../../shared/contracts';

interface NewTaskPanelProps {
  defaultRepositoryPath: string;
  disabled?: boolean;
  onCreate(input: CreateTaskRequest): Promise<void>;
  onRefinePrompt(repositoryPath: string, input: string): Promise<RefinePromptResponse>;
  onClose(): void;
}

export function NewTaskPanel({
  defaultRepositoryPath,
  disabled,
  onCreate,
  onRefinePrompt,
  onClose
}: NewTaskPanelProps) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [repositoryPath, setRepositoryPath] = useState(defaultRepositoryPath);
  const [testCommand, setTestCommand] = useState('npm test');
  const [error, setError] = useState<string | undefined>();
  const [isRefining, setIsRefining] = useState(false);

  useEffect(() => {
    setRepositoryPath((current) => current || defaultRepositoryPath);
  }, [defaultRepositoryPath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      await onCreate({ title, prompt, repositoryPath, testCommand });
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
    <div className="slideover" onClick={onClose}>
      <form
        className="slideover__panel"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="New task"
      >
        <header className="slideover__header">
          <div className="slideover__heading">
            <strong>New task</strong>
            <span>Define the work, target repository, and verification command.</span>
          </div>
          <button
            type="button"
            className="slideover__close"
            aria-label="Close"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="slideover__body">
          <label className="field">
            <span>Title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Add settings validation"
              disabled={disabled}
              autoFocus
            />
          </label>
          <label className="field">
            <span>Repository</span>
            <input
              className="field__mono"
              value={repositoryPath}
              onChange={(event) => setRepositoryPath(event.target.value)}
              placeholder="/path/to/repository"
              disabled={disabled}
            />
          </label>
          <label className="field">
            <span>Test command</span>
            <input
              className="field__mono"
              value={testCommand}
              onChange={(event) => setTestCommand(event.target.value)}
              placeholder="npm test"
              disabled={disabled}
            />
          </label>
          <div className="field field--prompt">
            <span className="field__header">
              <label htmlFor="task-prompt">Prompt</label>
              <button
                className="field__refine"
                type="button"
                disabled={disabled || isRefining || !prompt.trim() || !repositoryPath.trim()}
                onClick={() => void refine()}
              >
                {isRefining ? 'Refining…' : 'Refine'}
              </button>
            </span>
            <textarea
              id="task-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the implementation request, constraints, and expected verification."
              disabled={disabled}
            />
          </div>
          {error ? <p className="form-error">{error}</p> : null}
        </div>

        <footer className="slideover__footer">
          <span>Creates a task without starting implementation.</span>
          <div className="slideover__footer-actions">
            <button type="button" className="outline-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={disabled || !title.trim() || !prompt.trim() || !repositoryPath.trim()}
            >
              Create task
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
