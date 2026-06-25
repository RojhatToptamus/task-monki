import type { CSSProperties } from 'react';
import type { Task } from '../../shared/contracts';
import type { AgentModel } from '../../shared/agent';
import { resolveReasoningEffort } from '../model/agentExecutionSettings';
import { describeTaskAttention } from './BoardView';
import { humanizeEnum } from './display';
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
  theme: 'light' | 'dark';
  onSetTheme(theme: 'light' | 'dark'): void;
  appSettings: AppSettings;
  onSetAppSettings(settings: AppSettings): void;
  error?: string;
  models: AgentModel[];
  defaultRepositoryPath: string;
  onSelect(taskId: string): void;
}

export interface AppSettings {
  defaultModel?: string;
  defaultReasoningEffort?: string;
  reviewModel?: string;
  reviewReasoningEffort?: string;
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
  error,
  models,
  defaultRepositoryPath,
  onSelect
}: MainColumnProps) {
  const head = VIEW_TITLES[view];

  return (
    <main className="tm-main">
      <div className="tm-main__head">
        <div style={{ minWidth: 0 }}>
          <h1 className="tm-main__title">{head.title}</h1>
          <span className="tm-main__subtitle">{head.subtitle(tasks)}</span>
        </div>
        <span className="tm-main__sync">Autonomous · last sync just now</span>
      </div>

      {error ? <div className="tm-error">{error}</div> : null}

      {view === 'board' ? <BoardKanban tasks={tasks} onSelect={onSelect} /> : null}
      {view === 'active' || view === 'review' || view === 'done' ? (
        <CardGrid tasks={tasksForView(tasks, view)} onSelect={onSelect} />
      ) : null}
      {view === 'inbox' ? <Inbox tasks={tasks} onSelect={onSelect} /> : null}
      {view === 'settings' ? (
        <Settings
          theme={theme}
          onSetTheme={onSetTheme}
          appSettings={appSettings}
          onSetAppSettings={onSetAppSettings}
          models={models}
          defaultRepositoryPath={defaultRepositoryPath}
        />
      ) : null}
    </main>
  );
}

function BoardKanban({ tasks, onSelect }: { tasks: Task[]; onSelect(id: string): void }) {
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
                <TaskCard key={task.id} vm={buildTaskCardVM(task)} onSelect={onSelect} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CardGrid({ tasks, onSelect }: { tasks: Task[]; onSelect(id: string): void }) {
  return (
    <div className="tm-grid">
      {tasks.length === 0 ? (
        <div className="tm-grid__empty">Nothing here right now.</div>
      ) : (
        <div className="tm-grid__inner">
          {tasks.map((task) => (
            <TaskCard key={task.id} vm={buildTaskCardVM(task)} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskCard({ vm, onSelect }: { vm: TaskCardVM; onSelect(id: string): void }) {
  return (
    <button
      type="button"
      className={`tm-card ${vm.hasDecision ? 'tm-card--decision' : ''}`}
      onClick={() => onSelect(vm.id)}
    >
      {vm.hasDecision ? (
        <div className="tm-card__decisionbar">
          <span className="tm-pulse" />
          {vm.decisionLabel}
        </div>
      ) : null}
      <div className="tm-card__top">
        <span className="tm-card__num">{vm.num}</span>
        <span style={{ flex: 1 }} />
        <Chip tone={vm.stateTone} label={vm.stateLabel} />
      </div>
      <strong className="tm-card__title">{vm.title}</strong>
      <div className="tm-card__meta">{vm.meta}</div>
      <div className="tm-card__rollups">
        {vm.rollups.map((rollup, index) => (
          <span className="tm-rollup" key={index}>
            <span className="tm-rollup__dot" style={dotStyle(rollup.tone)} />
            {rollup.label}
          </span>
        ))}
      </div>
    </button>
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
                  <span className="tm-decision__wait">
                    {humanizeEnum(task.projection.agentRun)}
                  </span>
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
  models,
  defaultRepositoryPath
}: {
  theme: 'light' | 'dark';
  onSetTheme(theme: 'light' | 'dark'): void;
  appSettings: AppSettings;
  onSetAppSettings(settings: AppSettings): void;
  models: AgentModel[];
  defaultRepositoryPath: string;
}) {
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const selectedDefaultModel =
    models.find((model) => model.model === appSettings.defaultModel) ?? defaultModel;
  const selectedReviewModel =
    models.find((model) => model.model === appSettings.reviewModel) ?? selectedDefaultModel;
  const selectedDefaultEffort =
    resolveReasoningEffort(selectedDefaultModel, appSettings.defaultReasoningEffort) ?? '';
  const selectedReviewEffort =
    resolveReasoningEffort(selectedReviewModel, appSettings.reviewReasoningEffort) ?? '';
  const rows: Array<{ k: string; hint: string; v: string }> = [
    {
      k: 'Repository',
      hint: 'Default working repository',
      v: defaultRepositoryPath ? repositoryName(defaultRepositoryPath) : 'Not set'
    },
    { k: 'Test command', hint: 'Run for verification', v: 'npm test' }
  ];

  return (
    <div className="tm-settings">
      <div className="tm-settings__card">
        <div className="tm-settings__row">
          <div style={{ minWidth: 0 }}>
            <div className="tm-settings__k">Theme</div>
            <div className="tm-settings__hint">App appearance</div>
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
              ...appSettings,
              defaultModel: model || undefined,
              defaultReasoningEffort: resolveReasoningEffort(
                nextModel,
                appSettings.defaultReasoningEffort
              )
            });
          }}
          onEffortChange={(reasoningEffort) =>
            onSetAppSettings({
              ...appSettings,
              defaultReasoningEffort: reasoningEffort || undefined
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
              ...appSettings,
              reviewModel: model || undefined,
              reviewReasoningEffort: resolveReasoningEffort(
                nextModel,
                appSettings.reviewReasoningEffort
              )
            });
          }}
          onEffortChange={(reasoningEffort) =>
            onSetAppSettings({
              ...appSettings,
              reviewReasoningEffort: reasoningEffort || undefined
            })
          }
        />
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

function ModelSettingRow({
  label,
  hint,
  value,
  effortValue,
  models,
  onModelChange,
  onEffortChange
}: {
  label: string;
  hint: string;
  value: string;
  effortValue: string;
  models: AgentModel[];
  onModelChange(value: string): void;
  onEffortChange(value: string): void;
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
          {effortValue ? ` · ${effortValue}` : ''}
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
      </div>
    </div>
  );
}

export function Chip({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`tm-chip tm-chip--${tone}`}>
      <span className="tm-chip__dot" />
      {label}
    </span>
  );
}

export function dotStyle(tone: Tone): CSSProperties {
  return { background: `var(--${tone})` };
}
