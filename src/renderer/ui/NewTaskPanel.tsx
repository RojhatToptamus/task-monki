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
  const repositoryPath = defaultRepositoryPath.trim();
  const reasoningEfforts = [
    ...new Set(
      [
        ...(selectedModel?.supportedReasoningEfforts ?? []),
        selectedModel?.defaultReasoningEffort,
        reasoningEffort
      ].filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
    )
  ];

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
    if (!repositoryPath) {
      setError('Select a repository before creating a task.');
      return;
    }
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
    if (!repositoryPath) {
      setError('Select a repository before refining the description.');
      return;
    }
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
            <span>Define the work and how Codex should run.</span>
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
          <section className="newtask-section" aria-label="Task essentials">
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

            <div className="field field--prompt">
              <span className="field__header">
                <span className="field__label">
                  <label htmlFor="task-description">Description</label>
                </span>
                <button
                  className="field__refine"
                  type="button"
                  disabled={disabled || isRefining || !prompt.trim() || !repositoryPath}
                  onClick={() => void refine()}
                >
                  <SparkleIcon />
                  {isRefining ? 'Refining...' : 'Refine'}
                </button>
              </span>
              <textarea
                id="task-description"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the implementation request, constraints, and expected verification."
                disabled={disabled}
              />
            </div>
          </section>

          <section className="newtask-section" aria-label="Run configuration">
            <div className="newtask-section__heading">
              <span>Run configuration</span>
              <i aria-hidden="true" />
            </div>

            <div className="field-grid field-grid--two">
              <label className="field">
                <span className="field__label">
                  Codex model
                </span>
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
              <div className="field">
                <span className="field__label">
                  Reasoning effort
                </span>
                <div className="segmented-effort" role="group" aria-label="Reasoning effort">
                  {reasoningEfforts.map((effort) => (
                    <button
                      key={effort}
                      type="button"
                      className={`segmented-effort__button ${
                        effort === reasoningEffort ? 'segmented-effort__button--active' : ''
                      }`}
                      disabled={disabled || !selectedModel}
                      onClick={() => setReasoningEffort(effort)}
                    >
                      {formatEffortLabel(effort)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="field-grid field-grid--two">
              <label className="field">
                <span className="field__label">
                  Sandbox
                  <HelpTooltip>
                    Implementation runs default to workspace-write. Analysis and review
                    runs always stay read-only.
                  </HelpTooltip>
                </span>
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
              </label>
              <label className="field">
                <span className="field__label">
                  Approval policy
                  <HelpTooltip align="right">
                    Keep approvals on unless you are comfortable with the selected sandbox
                    and repository access.
                  </HelpTooltip>
                </span>
                <select
                  value={approvalPolicy}
                  onChange={(event) => setApprovalPolicy(event.target.value)}
                  disabled={disabled}
                >
                  <option value="on-request">Ask before privileged actions</option>
                  <option value="never">Never ask</option>
                </select>
              </label>
            </div>

            <label className="field">
              <span className="field__label">
                Test command
              </span>
              <input
                className="field__mono"
                value={testCommand}
                onChange={(event) => setTestCommand(event.target.value)}
                placeholder="npm test"
                disabled={disabled}
              />
            </label>

            <div className="network-toggle">
              <div className="network-toggle__copy">
                <span className="network-toggle__title">
                  Allow network access
                </span>
                <span className="network-toggle__state">
                  {networkAccess
                    ? 'Enabled - agent may use the network during this run.'
                    : 'Disabled - approval required before network use.'}
                </span>
              </div>
              <button
                type="button"
                className={`network-toggle__switch ${
                  networkAccess ? 'network-toggle__switch--on' : ''
                }`}
                role="switch"
                aria-checked={networkAccess}
                disabled={disabled}
                onClick={() => setNetworkAccess((current) => !current)}
              >
                <span />
              </button>
            </div>
          </section>

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
          <span className="slideover__footer-note">
            <InfoCircleIcon />
            <span>Creates a task without starting implementation.</span>
          </span>
          <div className="slideover__footer-actions">
            <button type="button" className="outline-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={disabled || !title.trim() || !prompt.trim() || !repositoryPath}
            >
              Create task
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function HelpTooltip({
  children,
  align = 'left',
  position = 'below'
}: {
  children: string;
  align?: 'left' | 'right';
  position?: 'above' | 'below';
}) {
  return (
    <span
      className={`info-tip info-tip--${align} info-tip--${position}`}
      onClick={(event) => event.preventDefault()}
    >
      <button type="button" className="info-tip__button" aria-label="More info">
        <InfoIcon />
      </button>
      <span className="info-tip__bubble" role="tooltip">
        {children}
      </span>
    </span>
  );
}

function InfoIcon() {
  return (
    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none">
      <path d="M12 11v6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="12" cy="6.5" r="1.6" fill="currentColor" />
    </svg>
  );
}

function InfoCircleIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.9" />
      <path d="M12 8v5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="12" cy="16" r="1" fill="currentColor" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3l1.9 4.8L19 9.5l-4 3.4L16 18l-4-2.7L8 18l1-5.1-4-3.4 5.1-.7z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatEffortLabel(effort: string): string {
  if (effort.toLowerCase() === 'xhigh') {
    return 'X-high';
  }
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
