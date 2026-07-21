import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createInitialProjection,
  type InteractionRequestRecord,
  type Task
} from '../../shared/contracts';
import { InboxDecisionCard, TaskCard } from './MainColumn';
import type { TaskCardVM } from '../model/taskView';

describe('TaskCard', () => {
  it('keeps distinguishing status and evidence text without default hashes or decorative dots', () => {
    const vm: TaskCardVM = {
      id: 'task-12345678',
      title: 'Review the repository change',
      meta: 'repo-secondary',
      repositoryId: 'repository-a',
      stateLabel: 'Needs approval',
      stateTone: 'action',
      showState: true,
      archived: false,
      evidence: [{ value: 'PR #42', label: 'checks failing', tone: 'error' }]
    };
    const html = renderToStaticMarkup(
      <TaskCard vm={vm} onSelect={() => {}} onArchive={() => {}} onRequestDelete={() => {}} />
    );

    expect(html).toContain('<h3 class="tm-card__title">Review the repository change</h3>');
    expect(html).toContain(
      '<div class="tm-card__top"><span class="tm-card__meta">repo-secondary</span>'
    );
    expect(html.indexOf('repo-secondary')).toBeLessThan(
      html.indexOf('<h3 class="tm-card__title">Review the repository change</h3>')
    );
    expect(html.match(/tm-card__meta/g)).toHaveLength(1);
    expect(html).toContain('Needs approval');
    expect(html).toContain('PR #42');
    expect(html).toContain('checks failing');
    expect(html).not.toContain('#task-12');
    expect(html).not.toContain('status-pill__dot');
    expect(html).not.toContain('tm-card__evidence-dot');
  });

  it('uses the heading level supplied by the owning board lane or ungrouped grid', () => {
    const vm: TaskCardVM = {
      id: 'task-heading',
      title: 'Heading context',
      repositoryId: 'repository-a',
      stateLabel: 'Ready',
      stateTone: 'neutral',
      showState: false,
      archived: false,
      evidence: []
    };
    const boardHtml = renderToStaticMarkup(
      <TaskCard
        vm={vm}
        headingLevel={3}
        onSelect={() => {}}
        onArchive={() => {}}
        onRequestDelete={() => {}}
      />
    );
    const gridHtml = renderToStaticMarkup(
      <TaskCard
        vm={vm}
        headingLevel={2}
        onSelect={() => {}}
        onArchive={() => {}}
        onRequestDelete={() => {}}
      />
    );

    expect(boardHtml).toContain('<h3 class="tm-card__title">Heading context</h3>');
    expect(boardHtml).toContain('data-task-id="task-heading" tabindex="0"');
    expect(gridHtml).toContain('<h2 class="tm-card__title">Heading context</h2>');
    expect(boardHtml).not.toContain('tm-card__top');
  });

  it('allows a board lane to make non-active cards arrow-reachable without tab stops', () => {
    const vm: TaskCardVM = {
      id: 'task-roving',
      title: 'Roving card',
      repositoryId: 'repository-a',
      stateLabel: 'Ready',
      stateTone: 'neutral',
      showState: false,
      archived: false,
      evidence: []
    };
    const html = renderToStaticMarkup(
      <TaskCard
        vm={vm}
        tabIndex={-1}
        onSelect={() => {}}
        onArchive={() => {}}
        onRequestDelete={() => {}}
      />
    );

    expect(html).toContain('data-task-id="task-roving" tabindex="-1"');
  });
});

describe('InboxDecisionCard', () => {
  it('renders a compact semantic row with one primary Open task action', () => {
    const task = attentionTask();
    const html = renderToStaticMarkup(
      <InboxDecisionCard
        task={task}
        repositoryName="repo"
        showRepository={false}
        onSelect={() => {}}
        onRespondToInteraction={async () => {}}
      />
    );

    expect(html).toContain('<article class="tm-decision">');
    expect(html).toContain('<h2 class="tm-decision__title">Awaiting approval</h2>');
    expect(html).toContain('Provider is blocked on a permission decision.');
    expect(html).toContain('class="tm-decision__open primary-button"');
    expect(html).not.toContain('tm-pulse');
    expect(html).not.toContain('tm-decision__repository');
  });

  it('exposes missing repository identity when the Inbox selector requests it', () => {
    const html = renderToStaticMarkup(
      <InboxDecisionCard
        task={attentionTask()}
        repositoryName="Missing repository"
        showRepository
        onSelect={() => {}}
        onRespondToInteraction={async () => {}}
      />
    );

    expect(html).toContain('tm-decision__repository');
    expect(html).toContain('Missing repository');
  });

  it('keeps Open task contextual when an inline approval is the primary action', () => {
    const html = renderToStaticMarkup(
      <InboxDecisionCard
        task={attentionTask()}
        repositoryName="repo"
        showRepository={false}
        interaction={approvalInteraction()}
        onSelect={() => {}}
        onRespondToInteraction={async () => {}}
      />
    );

    expect(html).toContain('class="primary-button tm-decision__approve"');
    expect(html).toContain('class="outline-button tm-decision__deny"');
    expect(html).toContain('class="tm-decision__open"');
    expect(html).not.toContain('class="tm-decision__open primary-button"');
  });
});

function attentionTask(): Task {
  const now = '2026-07-19T12:00:00.000Z';
  return {
    id: 'task-attention',
    title: 'Awaiting approval',
    prompt: 'Approve the requested action.',
    repositoryId: 'repository-a',
    runtimeId: 'codex',
    workflowPhase: 'IN_PROGRESS',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: now,
    updatedAt: now,
    projection: {
      ...createInitialProjection(now),
      agentRun: 'AWAITING_APPROVAL'
    }
  };
}

function approvalInteraction(): InteractionRequestRecord {
  return {
    id: 'interaction-1',
    runtimeId: 'codex',
    serverInstanceId: 'server-1',
    providerRequestId: 1,
    taskId: 'task-attention',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    type: 'COMMAND_APPROVAL',
    status: 'PENDING',
    request: {
      startedAtMs: 1,
      command: 'npm test',
      cwd: '/tmp/repository-a',
      commandActions: [{ type: 'unknown', command: 'npm test' }]
    },
    allowedActions: ['ACCEPT', 'DECLINE'],
    policyWarnings: [],
    requestRawMessage: {
      serverInstanceId: 'server-1',
      sequence: 1,
      direction: 'INBOUND',
      recordedAt: '2026-07-19T12:00:00.000Z',
      byteOffset: 0,
      byteLength: 1,
      sha256: 'seed'
    },
    requestedAt: '2026-07-19T12:00:00.000Z'
  };
}
