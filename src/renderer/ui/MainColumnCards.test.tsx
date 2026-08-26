import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InteractionRequestRecord } from '../../shared/contracts';
import { makeRawMessage, makeTaskRecord } from '../../testSupport/rendererRecords';
import { InboxDecisionCard, TaskCard } from './MainColumn';
import type { TaskCardVM } from '../model/taskView';

describe('TaskCard', () => {
  it('renders the task identity, state, and local evidence supplied by its model', () => {
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

    expect(html).toContain('Review the repository change');
    expect(html).toContain('repo-secondary');
    expect(html).toContain('Needs approval');
    expect(html).toContain('PR #42');
    expect(html).toContain('checks failing');
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

    expect(boardHtml).toContain('<h3');
    expect(boardHtml).toContain('>Heading context</h3>');
    expect(boardHtml).toContain('data-task-id="task-heading" tabindex="0"');
    expect(gridHtml).toContain('<h2');
    expect(gridHtml).toContain('>Heading context</h2>');
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
  it('renders the attention reason with task navigation', () => {
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

    expect(html).toContain('<article');
    expect(html).toContain('<h2');
    expect(html).toContain('>Awaiting approval</h2>');
    expect(html).toContain('Provider is blocked on a permission decision.');
    expect(html).toContain('>Open task</button>');
  });

  it('shows repository identity when the Inbox selector requests it', () => {
    const html = renderToStaticMarkup(
      <InboxDecisionCard
        task={attentionTask()}
        repositoryName="Missing repository"
        showRepository
        onSelect={() => {}}
        onRespondToInteraction={async () => {}}
      />
    );

    expect(html).toContain('Missing repository');
  });

  it('offers an inline approval without hiding task navigation', () => {
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

    expect(html).toContain('>Approve</button>');
    expect(html).toContain('>Deny</button>');
    expect(html).toContain('>Open task</button>');
  });
});

function attentionTask() {
  return makeTaskRecord({
    id: 'task-attention',
    title: 'Awaiting approval',
    prompt: 'Approve the requested action.',
    repositoryId: 'repository-a',
    workflowPhase: 'IN_PROGRESS',
    projection: {
      agentRun: 'AWAITING_APPROVAL'
    }
  });
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
    requestRawMessage: makeRawMessage({ sha256: 'seed' }),
    requestedAt: '2026-07-19T12:00:00.000Z'
  };
}
