import { useEffect, useState } from 'react';
import type {
  AgentExecutionSettings,
  AgentModel,
  AgentPreflight,
  CreateTaskRequest,
  RefinePromptResponse
} from '../../shared/contracts';

interface NewTaskPanelProps {
  defaultRepositoryPath: string;
  models: AgentModel[];
  preflight?: AgentPreflight;
  defaultAgentSettings?: AgentExecutionSettings;
  disabled?: boolean;
  onCreate(input: CreateTaskRequest): Promise<void>;
  onRefinePrompt(repositoryPath: string, input: string): Promise<RefinePromptResponse>;
  onClose(): void;
}

export function NewTaskPanel({
  defaultRepositoryPath,
  models,
  preflight,
  defaultAgentSettings,
  disabled,
  onCreate,
  onRefinePrompt,
  onClose
}: NewTaskPanelProps) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [repositoryPath, setRepositoryPath] = useState(defaultRepositoryPath);
  const [testCommand, setTestCommand] = useState('npm test');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [sandbox, setSandbox] =
    useState<NonNullable<AgentExecutionSettings['sandbox']>>('WORKSPACE_WRITE');
  const [networkAccess, setNetworkAccess] = useState(false);
  const [approvalPolicy, setApprovalPolicy] = useState('on-request');
  const [error, setError] = useState<string | undefined>();
  const [isRefining, setIsRefining] = useState(false);

  useEffect(() => {
    setRepositoryPath((current) => current || defaultRepositoryPath);
  }, [defaultRepositoryPath]);

  useEffect(() => {
    if (model) {
      return;
    }
    const defaultModel =
      models.find((candidate) => candidate.model === defaultAgentSettings?.model) ??
      models.find((candidate) => candidate.isDefault) ??
      models[0];
    if (defaultModel) {
      setModel(defaultModel.model);
      setReasoningEffort(
        defaultAgentSettings?.reasoningEffort ?? defaultModel.defaultReasoningEffort ?? ''
      );
    }
  }, [defaultAgentSettings?.model, defaultAgentSettings?.reasoningEffort, model, models]);

  const selectedModel = models.find((candidate) => candidate.model === model);

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
      await onCreate({
        title,
        prompt,
        repositoryPath,
        testCommand,
        agentSettings: {
          model: model || undefined,
          modelProvider: defaultAgentSettings?.modelProvider ?? 'openai',
          reasoningEffort: reasoningEffort || undefined,
          sandbox,
          networkAccess,
          approvalPolicy
        }
      });
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
            <span>Codex model</span>
            <select
              value={model}
              onChange={(event) => {
                const nextModel = models.find(
                  (candidate) => candidate.model === event.target.value
                );
                setModel(event.target.value);
                setReasoningEffort(nextModel?.defaultReasoningEffort ?? '');
              }}
              disabled={disabled || models.length === 0}
            >
              {models
                .filter((candidate) => !candidate.hidden || candidate.model === model)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.model}>
                    {candidate.displayName}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>Reasoning effort</span>
            <select
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.target.value)}
              disabled={disabled || !selectedModel}
            >
              {(selectedModel?.supportedReasoningEfforts ?? []).map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
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
          <label className="field">
            <span>Sandbox</span>
            <select
              value={sandbox}
              onChange={(event) =>
                setSandbox(event.target.value as NonNullable<AgentExecutionSettings['sandbox']>)
              }
              disabled={disabled}
            >
              <option value="WORKSPACE_WRITE">Workspace write</option>
              <option value="READ_ONLY">Read only</option>
              <option value="DANGER_FULL_ACCESS">Full access</option>
            </select>
            <small>
              Implementation runs default to workspace-write. Analysis and review runs still
              enforce read-only.
            </small>
          </label>
          <label className="field">
            <span>Approval policy</span>
            <select
              value={approvalPolicy}
              onChange={(event) => setApprovalPolicy(event.target.value)}
              disabled={disabled}
            >
              <option value="on-request">Ask before privileged actions</option>
              <option value="never">Never ask</option>
            </select>
            <small>
              Keep approvals on unless you are comfortable with the selected sandbox and
              repository access.
            </small>
          </label>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={networkAccess}
              onChange={(event) => setNetworkAccess(event.target.checked)}
              disabled={disabled}
            />
            <span>
              <strong>Allow network access</strong>
              <small>
                Off by default. The agent must request approval before network use unless
                this is enabled.
              </small>
            </span>
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
          {!preflight?.ready ? (
            <p className="form-error">
              {preflight?.problems.join(' ') ||
                'Codex App Server is unavailable. You can create the task now and start it after Codex is ready.'}
            </p>
          ) : null}
          {preflight?.warnings.map((warning) => (
            <p className="form-warning" key={warning}>
              {warning}
            </p>
          ))}
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
              disabled={
                disabled ||
                !title.trim() ||
                !prompt.trim() ||
                !repositoryPath.trim()
              }
            >
              Create task
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
