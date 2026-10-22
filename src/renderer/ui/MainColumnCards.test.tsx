import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InteractionRequestRecord } from '../../shared/contracts';
import { makeRawMessage, makeTaskRecord } from '../../testSupport/rendererRecords';
import { InboxRow, TaskCard } from './MainColumn';
import type { TaskCardVM } from '../model/taskView';

describe('TaskCard', () => {
  it('states a refining status once as a toned badge and names the pull request once', () => {
    const vm: TaskCardVM = {
      id: 'task-12345678',
      title: 'Review the repository change',
      meta: 'repo-secondary',
      repositoryId: 'repository-a',
      stateLabel: 'Needs approval',
      stateTone: 'action',
      stateInFlight: false,
      showState: true,
      archived: false,
      pullRequest: { label: '#42', state: 'open', note: 'checks pending' }
    };
    const html = renderToStaticMarkup(
      <TaskCard vm={vm} onSelect={() => {}} onArchive={() => {}} onRequestDelete={() => {}} />
    );

    expect(html).toContain('Review the repository change');
    expect(html).toContain('repo-secondary');
    // A status that needs the user is a badge in the waiting tone, stated once.
    expect(html).toContain('status-pill--action');
    expect(html.match(/Needs approval/g)).toHaveLength(1);
    expect(html).toContain('#42');
    expect(html).toContain('checks pending');
  });

  it('omits a status that restates the lane, leaving no empty footer', () => {
    const vm: TaskCardVM = {
      id: 'task-ready',
      title: 'Ready task',
      repositoryId: 'repository-a',
      stateLabel: 'Ready',
      stateTone: 'neutral',
      stateInFlight: false,
      showState: false,
      archived: false
    };
    const html = renderToStaticMarkup(
      <TaskCard vm={vm} onSelect={() => {}} onArchive={() => {}} onRequestDelete={() => {}} />
    );

    expect(html).not.toContain('>Ready<');
    expect(html).not.toContain('tm-card__foot');
  });

  it('uses the heading level supplied by the owning board lane or ungrouped grid', () => {
    const vm: TaskCardVM = {
      id: 'task-heading',
      title: 'Heading context',
      repositoryId: 'repository-a',
      stateLabel: 'Ready',
      stateTone: 'neutral',
      stateInFlight: false,
      showState: false,
      archived: false
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
      stateInFlight: false,
      showState: false,
      archived: false
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

describe('InboxRow', () => {
  it('says why the task waits in the board card word and opens the task from the whole row', () => {
    const task = attentionTask();
    const html = renderToStaticMarkup(
      <InboxRow
        task={task}
        repositoryName="repo"
        showRepository={false}
        onSelect={() => {}}
        onRespondToInteraction={async () => {}}
      />
    );

    expect(html).toContain('<li');
    expect(html).toContain('>Needs approval</span>');
    expect(html).toContain('>Awaiting approval</h2>');
    expect(html).toContain('aria-label="Open Awaiting approval"');
    // No per-row "Open task" button, and no sentence restating the status.
    expect(html).not.toContain('Open task');
    expect(html).not.toContain('tm-inbox-row__detail');
  });

  it('shows repository identity when the Inbox selector requests it', () => {
    const html = renderToStaticMarkup(
      <InboxRow
        task={attentionTask()}
        repositoryName="Missing repository"
        showRepository
        onSelect={() => {}}
        onRespondToInteraction={async () => {}}
      />
    );

    expect(html).toContain('Missing repository');
  });

  it('shows the command beside an inline approval, in the Agent tab order', () => {
    const html = renderToStaticMarkup(
      <InboxRow
        task={attentionTask()}
        repositoryName="repo"
        showRepository={false}
        interaction={approvalInteraction()}
        onSelect={() => {}}
        onRespondToInteraction={async () => {}}
      />
    );

    const subjectId = /<code id="([^"]+)" class="tm-inbox-row__subject">npm test<\/code>/.exec(html)?.[1];
    expect(subjectId).toBeTruthy();
    // Both decisions name the command they apply to.
    expect(html).toContain(`aria-describedby="${subjectId}">Deny</button>`);
    expect(html).toContain(`aria-describedby="${subjectId}">Allow once</button>`);
    expect(html.indexOf('>Deny</button>')).toBeLessThan(html.indexOf('>Allow once</button>'));
  });

  it('quotes what the agent asks when it waits for answers', () => {
    const html = renderToStaticMarkup(
      <InboxRow
        task={{ ...attentionTask(), projection: { ...attentionTask().projection, agentRun: 'AWAITING_USER_INPUT' } }}
        repositoryName="repo"
        showRepository={false}
        interaction={userInputInteraction()}
        onSelect={() => {}}
        onRespondToInteraction={async () => {}}
      />
    );

    expect(html).toContain('>Needs input</span>');
    expect(html).toContain('Which checks should run?');
    expect(html).toContain('1 more question<');
    expect(html).not.toContain('<button type="button" class="primary-button"');
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

function userInputInteraction(): InteractionRequestRecord {
  return {
    ...approvalInteraction(),
    id: 'interaction-2',
    type: 'USER_INPUT',
    request: {
      questions: [
        { id: 'checks', header: 'Checks', question: 'Which checks should run?', isOther: false, isSecret: false },
        { id: 'scope', header: 'Scope', question: 'What should stay unchanged?', isOther: false, isSecret: false }
      ]
    },
    allowedActions: ['ANSWER']
  };
}
