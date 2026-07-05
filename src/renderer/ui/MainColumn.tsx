import { useEffect, useState, type CSSProperties } from 'react';
import type { Task } from '../../shared/contracts';
import {
  DEFAULT_PROMPT_REFINEMENT_MODEL,
  type AgentModel,
  type ExternalToolId,
  type ExternalToolProbeResult,
  type ExternalToolStatusReport,
  type TaskManagerAppSettings,
  type TestExternalToolRequest,
  type UpdateAppSettingsRequest
} from '../../shared/contracts';
import { resolveReasoningEffort } from '../model/agentExecutionSettings';
import {
  buildExecutableTestRequest,
  selectExecutableDisplayStatus
} from '../model/executableSettings';
import { describeTaskAttention } from './BoardView';
import { humanizeEnum } from './display';
import { TaskActionsMenu } from './TaskActionsMenu';
import type { ThemePreference } from './theme';
import {
  BOARD_COLUMNS,
  buildTaskCardVM,
  columnTasks,
  repositoryName,
  tasksForView,
  type NavView,
  type TaskCardVM,
  type Tone
} from './taskView';

interface MainColumnProps {
  view: NavView;
  tasks: Task[];
  theme: ThemePreference;
  onSetTheme(theme: ThemePreference): void;
  appSettings: TaskManagerAppSettings;
  onSetAppSettings(settings: UpdateAppSettingsRequest, successMessage?: string): void;
  externalToolStatus?: ExternalToolStatusReport;
  onRefreshExternalTools(): Promise<ExternalToolStatusReport>;
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
  error?: string;
  models: AgentModel[];
  activeRepositoryPath: string;
  onSelect(taskId: string): void;
  onArchive(taskId: string): void;
  onRequestDelete(taskId: string): void;
}

const VIEW_TITLES: Record<NavView, { title: string; subtitle(tasks: Task[]): string }> = {
  inbox: {
    title: 'Inbox',
    subtitle: () => 'Decisions and runs waiting on you'
  },
  board: {
    title: 'Board',
    subtitle: (tasks) =>
      `${tasks.length} task${tasks.length === 1 ? '' : 's'} across the pipeline`
  },
  active: {
    title: 'Active runs',
    subtitle: (tasks) => `${tasksForView(tasks, 'active').length} tasks currently in flight`
  },
  review: {
    title: 'Review queue',
    subtitle: (tasks) =>
      `${tasksForView(tasks, 'review').length} tasks ready to verify and ship`
  },
  done: {
    title: 'Done & Archive',
    subtitle: (tasks) => `${tasksForView(tasks, 'done').length} completed tasks`
  },
  settings: {
    title: 'Settings',
    subtitle: () => 'Workspace defaults and provider configuration'
  }
};

export function MainColumn({
  view,
  tasks,
  theme,
  onSetTheme,
  appSettings,
  onSetAppSettings,
  externalToolStatus,
  onRefreshExternalTools,
  onTestExternalTool,
  error,
  models,
  activeRepositoryPath,
  onSelect,
  onArchive,
  onRequestDelete
}: MainColumnProps) {
  const head = VIEW_TITLES[view];

  return (
    <main className="tm-main">
      <div className="tm-main__head">
        <div style={{ minWidth: 0 }}>
          <h1 className="tm-main__title">{head.title}</h1>
          <span className="tm-main__subtitle">{head.subtitle(tasks)}</span>
        </div>
      </div>

      {error ? <div className="tm-error">{error}</div> : null}

      {view === 'board' ? (
        <BoardKanban
          tasks={tasks}
          onSelect={onSelect}
          onArchive={onArchive}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
      {view === 'active' || view === 'review' || view === 'done' ? (
        <CardGrid
          tasks={tasksForView(tasks, view)}
          onSelect={onSelect}
          onArchive={onArchive}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
      {view === 'inbox' ? <Inbox tasks={tasks} onSelect={onSelect} /> : null}
      {view === 'settings' ? (
        <Settings
          theme={theme}
          onSetTheme={onSetTheme}
          appSettings={appSettings}
          onSetAppSettings={onSetAppSettings}
          externalToolStatus={externalToolStatus}
          onRefreshExternalTools={onRefreshExternalTools}
          onTestExternalTool={onTestExternalTool}
          models={models}
          activeRepositoryPath={activeRepositoryPath}
        />
      ) : null}
    </main>
  );
}

function BoardKanban({
  tasks,
  onSelect,
  onArchive,
  onRequestDelete
}: {
  tasks: Task[];
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  return (
    <div className="tm-board">
      {BOARD_COLUMNS.map((column) => {
        const cards = columnTasks(tasks, column);
        return (
          <section className="tm-col" key={column.key}>
            <div className="tm-col__head">
              <span className="tm-col__dot" style={dotStyle(column.tone)} />
              <strong className="tm-col__label">{column.label}</strong>
              <span className="tm-col__count">{cards.length}</span>
            </div>
            <div className="tm-col__cards">
              {cards.map((task) => (
                <TaskCard
                  key={task.id}
                  vm={buildTaskCardVM(task)}
                  onSelect={onSelect}
                  onArchive={onArchive}
                  onRequestDelete={onRequestDelete}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CardGrid({
  tasks,
  onSelect,
  onArchive,
  onRequestDelete
}: {
  tasks: Task[];
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  return (
    <div className="tm-grid">
      {tasks.length === 0 ? (
        <div className="tm-grid__empty">Nothing here right now.</div>
      ) : (
        <div className="tm-grid__inner">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              vm={buildTaskCardVM(task)}
              onSelect={onSelect}
              onArchive={onArchive}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskCard({
  vm,
  onSelect,
  onArchive,
  onRequestDelete
}: {
  vm: TaskCardVM;
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRequestDelete(id: string): void;
}) {
  return (
    <article className={`tm-card ${vm.hasDecision ? 'tm-card--decision' : ''}`}>
      {/* Full-card click target sits behind the content so the kebab can be a
          real sibling next to the title (a button can't nest inside a button). */}
      <button
        type="button"
        className="tm-card__hit"
        aria-label={`Open ${vm.title}`}
        onClick={() => onSelect(vm.id)}
      />
      <div className="tm-card__body">
        <div className="tm-card__top">
          <span className="tm-card__num">{vm.num}</span>
          <span style={{ flex: 1 }} />
          <Chip tone={vm.stateTone} label={vm.stateLabel} />
        </div>
        <div className="tm-card__titlerow">
          <strong className="tm-card__title">{vm.title}</strong>
          <TaskActionsMenu
            taskId={vm.id}
            title={vm.title}
            archived={vm.archived}
            onArchive={onArchive}
            onRequestDelete={onRequestDelete}
            className="tm-card__actions"
          />
        </div>
        <div className="tm-card__meta">{vm.meta}</div>
        <div className="tm-card__evidence" aria-label="Task evidence">
          {vm.evidence.map((item, index) => (
            <span
              key={`${item.label}-${index}`}
              className={`tm-card__evidence-item ${
                item.tone ? `tm-card__evidence-item--${item.tone}` : ''
              }`}
            >
              <span className="tm-card__evidence-dot" aria-hidden="true" />
              {item.label}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

function Inbox({ tasks, onSelect }: { tasks: Task[]; onSelect(id: string): void }) {
  const decisions = tasks.filter((task) => describeTaskAttention(task));

  return (
    <div className="tm-inbox">
      <div className="tm-inbox__inner">
        {decisions.length === 0 ? (
          <div className="tm-inbox__empty">
            <span className="tm-inbox__empty-mark">✓</span>
            <strong>All clear</strong>
            <span>Nothing needs your decision. The pipeline is running itself.</span>
          </div>
        ) : (
          decisions.map((task) => {
            const attention = describeTaskAttention(task);
            return (
              <div className="tm-decision" key={task.id}>
                <div className="tm-decision__head">
                  <span className="tm-pulse" />
                  <span className="tm-decision__kind">{attention?.label}</span>
                </div>
                <strong className="tm-decision__title">{task.title}</strong>
                <div className="tm-decision__task">
                  {repositoryName(task.repositoryPath)} · {humanizeEnum(task.workflowPhase)}
                </div>
                <p className="tm-decision__summary">
                  {attention?.detail ?? task.projection.summary}
                </p>
                <div className="tm-decision__actions">
                  <button
                    type="button"
                    className="tm-decision__open"
                    onClick={() => onSelect(task.id)}
                  >
                    Open task →
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function Settings({
  theme,
  onSetTheme,
  appSettings,
  onSetAppSettings,
  externalToolStatus,
  onRefreshExternalTools,
  onTestExternalTool,
  models,
  activeRepositoryPath
}: {
  theme: ThemePreference;
  onSetTheme(theme: ThemePreference): void;
  appSettings: TaskManagerAppSettings;
  onSetAppSettings(settings: UpdateAppSettingsRequest, successMessage?: string): void;
  externalToolStatus?: ExternalToolStatusReport;
  onRefreshExternalTools(): Promise<ExternalToolStatusReport>;
  onTestExternalTool(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
  models: AgentModel[];
  activeRepositoryPath: string;
}) {
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const selectedDefaultModel =
    models.find((model) => model.model === appSettings.defaultModel) ?? defaultModel;
  const selectedReviewModel =
    models.find((model) => model.model === appSettings.reviewModel) ?? selectedDefaultModel;
  const selectedPromptRefinementModel =
    models.find((model) => model.model === appSettings.promptRefinementModel) ??
    models.find((model) => model.model === DEFAULT_PROMPT_REFINEMENT_MODEL) ??
    selectedDefaultModel;
  const selectedDefaultEffort =
    resolveReasoningEffort(selectedDefaultModel, appSettings.defaultReasoningEffort) ?? '';
  const selectedReviewEffort =
    resolveReasoningEffort(selectedReviewModel, appSettings.reviewReasoningEffort) ?? '';
  const rows: Array<{ k: string; hint: string; v: string }> = [
    {
      k: 'Repository',
      hint: 'Active task context',
      v: activeRepositoryPath ? repositoryName(activeRepositoryPath) : 'Not set'
    }
  ];

  return (
    <div className="tm-settings">
      <div className="tm-settings__card">
        <div className="tm-settings__row">
          <div style={{ minWidth: 0 }}>
            <div className="tm-settings__k">Theme</div>
          </div>
          <div className="tm-segtoggle" role="group" aria-label="Theme">
            <button
              type="button"
              className={`tm-segtoggle__btn ${theme === 'light' ? 'tm-segtoggle__btn--active' : ''}`}
              onClick={() => onSetTheme('light')}
            >
              Light
            </button>
            <button
              type="button"
              className={`tm-segtoggle__btn ${theme === 'dark' ? 'tm-segtoggle__btn--active' : ''}`}
              onClick={() => onSetTheme('dark')}
            >
              Dark
            </button>
            <button
              type="button"
              className={`tm-segtoggle__btn ${theme === 'device' ? 'tm-segtoggle__btn--active' : ''}`}
              onClick={() => onSetTheme('device')}
            >
              Device
            </button>
          </div>
        </div>
        <ModelSettingRow
          label="Default task model"
          hint="Used for new implementation tasks"
          value={selectedDefaultModel?.model ?? ''}
          effortValue={selectedDefaultEffort}
          models={models}
          onModelChange={(model) => {
            const nextModel = models.find((candidate) => candidate.model === model);
            onSetAppSettings({
              defaultModel: model || null,
              defaultReasoningEffort: resolveReasoningEffort(
                nextModel,
                appSettings.defaultReasoningEffort
              ) ?? null
            });
          }}
          onEffortChange={(reasoningEffort) =>
            onSetAppSettings({
              defaultReasoningEffort: reasoningEffort || null
            })
          }
        />
        <ModelSettingRow
          label="Prompt refinement model"
          hint="Used when improving task descriptions"
          value={selectedPromptRefinementModel?.model ?? ''}
          models={models}
          onModelChange={(model) =>
            onSetAppSettings({
              promptRefinementModel: model || null
            })
          }
        />
        <ModelSettingRow
          label="Codex review model"
          hint="Used for AI quality-gate reviews"
          value={selectedReviewModel?.model ?? ''}
          effortValue={selectedReviewEffort}
          models={models}
          onModelChange={(model) => {
            const nextModel = models.find((candidate) => candidate.model === model);
            onSetAppSettings({
              reviewModel: model || null,
              reviewReasoningEffort: resolveReasoningEffort(
                nextModel,
                appSettings.reviewReasoningEffort
              ) ?? null
            });
          }}
          onEffortChange={(reasoningEffort) =>
            onSetAppSettings({
              reviewReasoningEffort: reasoningEffort || null
            })
          }
        />
        <ExternalToolSettingRow
          label="Web search"
          hint="Codex search tool"
          value={appSettings.codexExternalTools.webSearchMode}
          options={[
            { value: 'disabled', label: 'Disabled' },
            { value: 'cached', label: 'Cached' },
            { value: 'live', label: 'Live' }
          ]}
          onChange={(webSearchMode) =>
            onSetAppSettings({
              codexExternalTools: { webSearchMode }
            })
          }
        />
        <ExternalToolSettingRow
          label="MCP servers"
          hint="Configured Codex servers"
          value={appSettings.codexExternalTools.mcpServers}
          options={[
            { value: 'disabled', label: 'Disabled' },
            { value: 'all', label: 'All enabled' }
          ]}
          onChange={(mcpServers) =>
            onSetAppSettings({
              codexExternalTools: { mcpServers }
            })
          }
        />
        <ExternalToolSettingRow
          label="Apps"
          hint="Codex apps and connectors"
          value={appSettings.codexExternalTools.apps}
          options={[
            { value: 'disabled', label: 'Disabled' },
            { value: 'enabled', label: 'Enabled' }
          ]}
          onChange={(apps) =>
            onSetAppSettings({
              codexExternalTools: { apps }
            })
          }
        />
        <ExecutableSettingRow
          tool="git"
          label="Git executable"
          hint="Required for repository evidence"
          value={appSettings.externalExecutables.gitExecutablePath}
          status={externalToolStatus?.tools.git}
          onSetPath={(gitExecutablePath) =>
            onSetAppSettings({
              externalExecutables: { gitExecutablePath }
            })
          }
          onTest={onTestExternalTool}
        />
        <ExecutableSettingRow
          tool="codex"
          label="Codex executable"
          hint="Required for agent runs"
          value={appSettings.externalExecutables.codexExecutablePath}
          status={externalToolStatus?.tools.codex}
          onSetPath={(codexExecutablePath) =>
            onSetAppSettings({
              externalExecutables: { codexExecutablePath }
            })
          }
          onTest={onTestExternalTool}
        />
        <ExecutableSettingRow
          tool="gh"
          label="GitHub CLI"
          hint="Optional for PR delivery"
          value={appSettings.externalExecutables.ghExecutablePath}
          status={externalToolStatus?.tools.gh}
          onSetPath={(ghExecutablePath) =>
            onSetAppSettings({
              externalExecutables: { ghExecutablePath }
            })
          }
          onTest={onTestExternalTool}
        />
        <div className="tm-settings__row">
          <div style={{ minWidth: 0 }}>
            <div className="tm-settings__k">Tool status</div>
            <div className="tm-settings__hint">
              {externalToolStatus
                ? `Checked ${formatSettingsTime(externalToolStatus.refreshedAt)}`
                : 'Not checked'}
            </div>
          </div>
          <button
            type="button"
            className="tm-settings__button"
            onClick={() => void onRefreshExternalTools()}
          >
            Refresh
          </button>
        </div>
        {rows.map((row) => (
          <div className="tm-settings__row" key={row.k}>
            <div style={{ minWidth: 0 }}>
              <div className="tm-settings__k">{row.k}</div>
              <div className="tm-settings__hint">{row.hint}</div>
            </div>
            <span className="tm-settings__v">{row.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExternalToolSettingRow<Value extends string>({
  label,
  hint,
  value,
  options,
  onChange
}: {
  label: string;
  hint: string;
  value: Value;
  options: Array<{ value: Value; label: string }>;
  onChange(value: Value): void;
}) {
  return (
    <div className="tm-settings__row">
      <div style={{ minWidth: 0 }}>
        <div className="tm-settings__k">{label}</div>
        <div className="tm-settings__hint">{hint}</div>
      </div>
      <div className="tm-settings__controls">
        <select
          className="tm-settings__select tm-settings__select--effort"
          value={value}
          onChange={(event) => onChange(event.target.value as Value)}
          aria-label={label}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ExecutableSettingRow({
  tool,
  label,
  hint,
  value,
  status,
  onSetPath,
  onTest
}: {
  tool: ExternalToolId;
  label: string;
  hint: string;
  value: string | null;
  status?: ExternalToolProbeResult;
  onSetPath(path: string | null): void;
  onTest(input: TestExternalToolRequest): Promise<ExternalToolProbeResult>;
}) {
  const savedPath = value ?? '';
  const [mode, setMode] = useState<'auto' | 'custom'>(savedPath ? 'custom' : 'auto');
  const [draftPath, setDraftPath] = useState(savedPath);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ExternalToolProbeResult>();
  // Feedback shown below the controls after the user clicks Test. Kept separate
  // from `testResult` (which feeds the passive badge) so the outcome message is
  // only tied to an explicit test action.
  const [testFeedback, setTestFeedback] = useState<ExecutableTestFeedback>();

  const resetTestFeedback = () => {
    setTestResult(undefined);
    setTestFeedback(undefined);
  };

  useEffect(() => {
    setMode(savedPath ? 'custom' : 'auto');
    setDraftPath(savedPath);
    resetTestFeedback();
  }, [savedPath]);

  const isCustom = mode === 'custom';
  const normalizedDraft = draftPath.trim();
  const hasPendingCustomPath = isCustom && normalizedDraft !== savedPath;
  const displayStatus = selectExecutableDisplayStatus(status, testResult);
  const badge = describeToolStatus(displayStatus);
  const resolvedMeta = displayStatus
    ? compactSettingsText(displayStatus.resolvedPath ?? displayStatus.executable)
    : null;
  const versionMeta =
    displayStatus?.status === 'ok' && displayStatus.version ? displayStatus.version : null;

  const runTest = async () => {
    setIsTesting(true);
    setTestResult(undefined);
    setTestFeedback({ state: 'running' });
    try {
      const result = await onTest(buildExecutableTestRequest(tool, mode, draftPath));
      setTestResult(result);
      setTestFeedback(
        result.status === 'ok'
          ? {
              state: 'passed',
              path: result.resolvedPath ?? result.executable,
              version: result.version
            }
          : { state: 'failed', message: result.error ?? 'The tool could not be verified.' }
      );
    } catch (caught) {
      setTestFeedback({
        state: 'failed',
        message: caught instanceof Error ? caught.message : 'The test could not be run.'
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="tm-exec">
      <div className="tm-exec__head">
        <div className="tm-exec__title" style={{ minWidth: 0 }}>
          <div className="tm-settings__k">{label}</div>
          <div className="tm-settings__hint">{hint}</div>
        </div>
        <span className={`tm-exec__badge tm-exec__badge--${badge.tone}`}>
          <span className="tm-exec__dot" aria-hidden="true" />
          {badge.label}
        </span>
      </div>

      {resolvedMeta ? (
        <div className="tm-exec__meta">
          <span className="tm-exec__source">{humanizeEnum(displayStatus!.source)}</span>
          <span className="tm-exec__path">{resolvedMeta}</span>
          {versionMeta ? <span className="tm-exec__version">{versionMeta}</span> : null}
        </div>
      ) : null}

      <div className="tm-exec__controls">
        <select
          className="tm-settings__select tm-settings__select--mode"
          value={mode}
          onChange={(event) => {
            const nextMode = event.target.value === 'custom' ? 'custom' : 'auto';
            setMode(nextMode);
            resetTestFeedback();
            if (nextMode === 'auto') {
              setDraftPath('');
              onSetPath(null);
            }
          }}
          aria-label={`${label} mode`}
        >
          <option value="auto">Auto</option>
          <option value="custom">Custom</option>
        </select>
        <input
          className="tm-settings__input"
          value={draftPath}
          onChange={(event) => {
            setDraftPath(event.target.value);
            resetTestFeedback();
          }}
          disabled={!isCustom}
          placeholder={displayStatus?.resolvedPath ?? displayStatus?.executable ?? 'Auto-detect'}
          aria-label={`${label} path`}
        />
        <div className="tm-exec__actions">
          {hasPendingCustomPath ? (
            <button
              type="button"
              className="tm-settings__button tm-settings__button--primary"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                resetTestFeedback();
                onSetPath(normalizedDraft || null);
              }}
            >
              Save
            </button>
          ) : null}
          <button
            type="button"
            className="tm-settings__button"
            disabled={isTesting}
            aria-busy={isTesting}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runTest()}
          >
            {isTesting ? 'Testing…' : 'Test'}
          </button>
          <button
            type="button"
            className="tm-settings__button"
            disabled={!savedPath && !draftPath}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setMode('auto');
              setDraftPath('');
              resetTestFeedback();
              onSetPath(null);
            }}
          >
            Reset
          </button>
        </div>
      </div>

      {testFeedback ? <ExecutableTestFeedbackStrip feedback={testFeedback} /> : null}
    </div>
  );
}

type ExecutableTestFeedback =
  | { state: 'running' }
  | { state: 'passed'; path: string; version: string | null }
  | { state: 'failed'; message: string };

function ExecutableTestFeedbackStrip({ feedback }: { feedback: ExecutableTestFeedback }) {
  if (feedback.state === 'running') {
    return (
      <div className="tm-exec__test tm-exec__test--running" role="status" aria-live="polite">
        <span className="tm-exec__spinner" aria-hidden="true" />
        <span>Testing…</span>
      </div>
    );
  }

  if (feedback.state === 'passed') {
    return (
      <div className="tm-exec__test tm-exec__test--passed" role="status" aria-live="polite">
        <span className="tm-exec__test-icon" aria-hidden="true">
          ✓
        </span>
        <span className="tm-exec__test-text">
          <strong>Test passed</strong>
        </span>
      </div>
    );
  }

  return (
    <div className="tm-exec__test tm-exec__test--failed" role="alert" aria-live="assertive">
      <span className="tm-exec__test-icon" aria-hidden="true">
        ✕
      </span>
      <span className="tm-exec__test-text">
        <strong>Test failed</strong>
        <span className="tm-exec__test-message">{feedback.message}</span>
      </span>
    </div>
  );
}

function describeToolStatus(
  status: ExternalToolProbeResult | undefined
): { tone: 'ok' | 'error' | 'muted'; label: string } {
  if (!status) {
    return { tone: 'muted', label: 'Not checked' };
  }
  if (status.status === 'ok') {
    return { tone: 'ok', label: 'Available' };
  }
  return {
    tone: status.required ? 'error' : 'muted',
    label: status.required ? 'Unavailable' : 'Optional'
  };
}

function compactSettingsText(value: string, maxLength = 72): string {
  if (value.length <= maxLength) {
    return value;
  }
  const headLength = 24;
  const tailLength = Math.max(12, maxLength - headLength - 3);
  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}

function formatSettingsTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'recently';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ModelSettingRow({
  label,
  hint,
  value,
  effortValue = '',
  models,
  onModelChange,
  onEffortChange
}: {
  label: string;
  hint: string;
  value: string;
  effortValue?: string;
  models: AgentModel[];
  onModelChange(value: string): void;
  onEffortChange?(value: string): void;
}) {
  const selected = models.find((model) => model.model === value);
  const efforts = [
    ...new Set(
      [
        ...(selected?.supportedReasoningEfforts ?? []),
        selected?.defaultReasoningEffort,
        effortValue
      ].filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
    )
  ];
  return (
    <div className="tm-settings__row">
      <div style={{ minWidth: 0 }}>
        <div className="tm-settings__k">{label}</div>
        <div className="tm-settings__hint">
          {hint}
          {onEffortChange && effortValue ? ` · ${effortValue}` : ''}
        </div>
      </div>
      <div className="tm-settings__controls">
        <select
          className="tm-settings__select tm-settings__select--model"
          value={value}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={models.length === 0}
          aria-label={`${label} model`}
        >
          {models
            .filter((model) => !model.hidden || model.model === value)
            .map((model) => (
              <option key={model.id} value={model.model}>
                {model.displayName}
              </option>
            ))}
        </select>
        {onEffortChange ? (
          <select
            className="tm-settings__select tm-settings__select--effort"
            value={effortValue}
            onChange={(event) => onEffortChange(event.target.value)}
            disabled={efforts.length === 0}
            aria-label={`${label} reasoning effort`}
          >
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}

export function Chip({
  tone,
  label,
  compact = false
}: {
  tone: Tone;
  label: string;
  compact?: boolean;
}) {
  const classes = [
    'status-pill',
    `status-pill--${tone}`,
    compact ? 'status-pill--compact' : ''
  ].filter(Boolean);

  return (
    <span className={classes.join(' ')}>
      <span className="status-pill__dot" aria-hidden="true" />
      <span className="status-pill__label">{label}</span>
    </span>
  );
}

export function dotStyle(tone: Tone): CSSProperties {
  return { background: `var(--${tone})` };
}
