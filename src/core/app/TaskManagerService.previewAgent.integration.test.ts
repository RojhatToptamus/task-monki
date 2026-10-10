import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientToolBridge } from '../agent/clientTools/ClientToolBridge';
import { git } from '../git/gitCli';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { TaskMonkiScenarioRegistry, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

const scenarioRegistry = new TaskMonkiScenarioRegistry();

afterEach(async () => {
  await scenarioRegistry.dispose();
});

const PROPOSAL_YAML = `name: application
type: environment
primary: web
services:
  web:
    type: command
    cwd: .
    command: [node, server.mjs]
    ports: { http: PORT }
    ready: { type: tcp, port: http }
`;

async function previewScenario(name: string) {
  const scenario = await scenarioRegistry.create({ name, previewEnabled: true });
  await scenario.commitFile('package.json', JSON.stringify({ scripts: { dev: 'node server.mjs' } }));
  await scenario.commitFile('server.mjs', 'import http from "node:http"; http.createServer().listen(Number(process.env.PORT));\n');
  const task = await scenario.createTask({ title: 'Preview agent conversation' });
  const worktree = await prepareTestWorktree(scenario.service, task.id);
  return { scenario, task, worktree };
}

function bridgeOf(scenario: TaskMonkiScenario): ClientToolBridge {
  return (scenario.service as unknown as { clientToolBridge: ClientToolBridge }).clientToolBridge;
}

describe('TaskManagerService Preview agent', () => {
  it('gives the recovery agent the failing service output through the real runtime log API', async () => {
    const { scenario, task, worktree } = await previewScenario('preview-agent-failure-logs');
    await fs.writeFile(path.join(worktree.worktreePath, 'preview.yaml'), JSON.stringify({
      name: 'application', type: 'environment', primary: 'web', services: {
        web: { type: 'command', cwd: '.', command: [process.execPath, '-e', "console.error('Missing local setup for web'); process.exit(4)"] }
      }
    }));
    const started = await scenario.service.startApplicationPreview({ taskId: task.id });
    const attemptId = started.status!.candidate!.id;
    await expect.poll(async () => (await scenario.service.getApplicationPreview({ taskId: task.id })).approval?.attemptId).toBe(attemptId);
    await scenario.service.approveApplicationPreview({ taskId: task.id, attemptId });
    await expect.poll(async () => (await scenario.service.getApplicationPreview({ taskId: task.id })).status?.latest?.state).toBe('failed');
    const message = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Investigate the web failure.' });
    const logs = await bridgeOf(scenario).invoke({
      tool: 'inspect_preview', runId: message.runId!, arguments: { what: 'logs', source: 'web', lines: 20 }
    });
    expect(logs.text).toContain('Missing local setup for web');
    expect(logs.text).toContain('(failed,');
  });

  it('tells the agent its run logs expired with the runtime instead of failing the tool call', async () => {
    const { scenario, task, worktree } = await previewScenario('preview-agent-expired-logs');
    await fs.writeFile(path.join(worktree.worktreePath, 'preview.yaml'), JSON.stringify({
      name: 'application', type: 'environment', primary: 'web', services: {
        web: { type: 'command', cwd: '.', command: [process.execPath, '-e', "console.error('output before restart'); process.exit(4)"] }
      }
    }));
    const started = await scenario.service.startApplicationPreview({ taskId: task.id });
    const attemptId = started.status!.candidate!.id;
    await expect.poll(async () => (await scenario.service.getApplicationPreview({ taskId: task.id })).approval?.attemptId).toBe(attemptId);
    await scenario.service.approveApplicationPreview({ taskId: task.id, attemptId });
    await expect.poll(async () => (await scenario.service.getApplicationPreview({ taskId: task.id })).status?.latest?.state).toBe('failed');
    // A runtime restart keeps the run's record and configuration but not its output.
    const applications = (scenario.service as unknown as { applications: { close(): Promise<void>; init(): Promise<void> } }).applications;
    await applications.close();
    await applications.init();
    const message = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Why did it fail?' });
    const logs = await bridgeOf(scenario).invoke({ tool: 'inspect_preview', runId: message.runId!, arguments: { what: 'logs', lines: 20 } });
    expect(logs.text).toContain('expired when the Preview runtime restarted');
    const status = await bridgeOf(scenario).invoke({ tool: 'inspect_preview', runId: message.runId!, arguments: { what: 'status' } });
    expect(status.text).toContain(attemptId);
  }, 30_000);

  it('starts the turn when provider activity lands on the run while its repository baseline is taken', async () => {
    const { scenario, task } = await previewScenario('preview-agent-concurrent-activity');
    // A resumed provider session (Codex) records activity for the queued run while Task Monki
    // inspects the repository; the baseline must not be rejected as a stale update.
    const store = scenario.runtimeStore;
    const getSession = store.getSession.bind(store);
    let landed = false;
    store.getSession = async (id: string) => {
      const session = await getSession(id);
      if (!landed && session?.role === 'PREVIEW') {
        // Only once the turn's submission is claimed, which is when the orchestrator takes its baseline.
        const starting = (await store.listRunsByOwner(session.owner)).find((candidate) => candidate.sessionId === id && candidate.status === 'STARTING');
        if (starting) {
          landed = true;
          await store.updateRun(starting.id, starting.recordRevision, { lastEventAt: new Date().toISOString() }, `provider-activity:${starting.id}`);
        }
      }
      return session;
    };
    const message = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Check the setup.' });
    expect(landed).toBe(true);
    expect(message).toMatchObject({ status: 'SUBMITTED' });
    const run = (await store.getRun(message.runId!))!;
    expect(run.repositoryIntegrity).toMatchObject({ status: 'PENDING', beforeFingerprint: expect.any(String) });
    expect(scenario.agent.startedTurns.at(-1)).toMatchObject({ mode: 'PREVIEW' });
  });

  it('names each registered checkout by the portable path preview.yaml uses, not one from the temporary worktree', async () => {
    const { scenario, task } = await previewScenario('preview-agent-checkout-paths');
    const backend = path.join(path.dirname(scenario.repositoryPath), 'sibling-backend');
    await fs.mkdir(backend);
    await git(backend, ['init', '-b', 'main']);
    await git(backend, ['-c', 'user.email=task-monki@example.invalid', '-c', 'user.name=Task Monki', 'commit', '--allow-empty', '-m', 'Initial commit']);
    await scenario.service.addRepository(backend);
    const message = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Which backends can I use?' });
    const status = JSON.parse((await bridgeOf(scenario).invoke({ tool: 'inspect_preview', runId: message.runId!, arguments: { what: 'status' } })).text);
    expect(status.repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'sibling-backend', configurationPath: '../sibling-backend' }),
      expect.objectContaining({ name: path.basename(scenario.repositoryPath), configurationPath: '.' })
    ]));
  });

  it('runs a detached PREVIEW conversation whose messages, questions and proposals never move the task workflow', async () => {
    const { scenario, task, worktree } = await previewScenario('preview-agent-conversation');
    const before = (await scenario.store.getTask(task.id))!;
    const proposalEvents: unknown[] = [];
    const unsubscribe = scenario.events.on((event) => {
      if (event.type === 'preview.recipe-generation.updated') proposalEvents.push(event.payload);
    });

    const message = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Draft a preview configuration.' });
    expect(message).toMatchObject({ role: 'PREVIEW', mode: 'FOLLOW_UP', status: 'SUBMITTED', text: 'Draft a preview configuration.' });
    const started = scenario.agent.startedTurns.at(-1)!;
    expect(started).toMatchObject({ mode: 'PREVIEW', instructionProfile: 'PREVIEW' });
    expect(started.prompt).toContain('Draft a preview configuration.');
    expect(started.prompt).toContain('[Preview state: no configuration file; never run]');
    expect(started.settings).toMatchObject({ sandbox: 'READ_ONLY', networkAccess: false, approvalPolicy: 'on-request' });

    const detail = await scenario.store.getTaskDetail(task.id);
    const run = detail.runs.find((candidate) => candidate.id === message.runId)!;
    expect(run).toMatchObject({ mode: 'PREVIEW', status: 'RUNNING', sessionId: message.sessionId });
    expect(detail.agentSessions.find((session) => session.id === run.sessionId)).toMatchObject({ role: 'PREVIEW' });
    const after = (await scenario.store.getTask(task.id))!;
    expect([after.workflowPhase, after.currentRunId, after.currentAgentSessionId]).toEqual([before.workflowPhase, before.currentRunId, before.currentAgentSessionId]);

    // The agent reads state and proposes through the app-owned tools of its run.
    const status = await bridgeOf(scenario).invoke({ tool: 'inspect_preview', runId: run.id, arguments: { what: 'status' } });
    expect(JSON.parse(status.text)).toMatchObject({
      configurationFile: null,
      runs: [],
      repositories: [expect.objectContaining({ path: await fs.realpath(scenario.repositoryPath), status: 'AVAILABLE' })]
    });
    const rejected = await bridgeOf(scenario).invoke({
      tool: 'propose_preview_configuration', runId: run.id,
      arguments: { yaml: 'name: application\ntype: static\n', summary: 'Serves the site.' }
    });
    expect(rejected.text).toMatch(/^Rejected\./);
    expect(rejected.text).toContain('INVALID_RECIPE');
    const accepted = await bridgeOf(scenario).invoke({
      tool: 'propose_preview_configuration', runId: run.id,
      arguments: { yaml: PROPOSAL_YAML, summary: 'Runs the Node server.', notes: ['Readiness checks the listener.'] }
    });
    expect(accepted.text).toMatch(/^Accepted\./);
    const generation = await scenario.service.getPreviewRecipeGeneration({ taskId: task.id });
    expect(generation).toMatchObject({ status: 'READY', draft: { yaml: PROPOSAL_YAML, report: { summary: 'Runs the Node server.', notes: ['Readiness checks the listener.'] } } });
    expect(proposalEvents.at(-1)).toMatchObject({ status: 'READY' });
    await expect(fs.access(path.join(worktree.worktreePath, 'preview.yaml'))).rejects.toThrow();

    // A primary run cannot call the Preview tools.
    await expect(bridgeOf(scenario).invoke({ tool: 'inspect_preview', runId: randomUUID(), arguments: { what: 'status' } }))
      .rejects.toThrow('only to the Preview agent');

    await scenario.completeRun(run.id, 'Proposed preview.yaml.');
    const saved = await scenario.service.acceptPreviewRecipeDraft({ taskId: task.id, draftId: generation.draft!.id, yaml: generation.draft!.yaml });
    expect(saved).toEqual({ recipePath: 'preview.yaml' });
    expect(await fs.readFile(path.join(worktree.worktreePath, 'preview.yaml'), 'utf8')).toBe(PROPOSAL_YAML);
    expect(proposalEvents.at(-1)).toMatchObject({ status: 'EMPTY' });
    expect((await scenario.service.getApplicationPreview({ taskId: task.id })).status?.active).toBeUndefined();
    unsubscribe();
  });

  it('queues messages behind the active turn, sends the next one when it completes, and holds the rest on Stop', async () => {
    const { scenario, task } = await previewScenario('preview-agent-queue');
    const first = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'First' });
    const second = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Second' });
    const third = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Third' });
    expect(second).toMatchObject({ role: 'PREVIEW', mode: 'QUEUE', status: 'QUEUED', sourceRunId: first.runId, sessionId: first.sessionId });
    expect(third).toMatchObject({ status: 'QUEUED', sourceRunId: first.runId });
    expect(scenario.agent.startedTurns).toHaveLength(1);

    await scenario.completeRun(first.runId!, 'Done with the first.');
    await scenario.waitForSnapshot((snapshot) => snapshot.taskInstructions.some((item) => item.id === second.id && item.status === 'SUBMITTED'));
    const detail = await scenario.store.getTaskDetail(task.id);
    const sent = detail.taskInstructions.find((item) => item.id === second.id)!;
    const waiting = detail.taskInstructions.find((item) => item.id === third.id)!;
    expect(sent.runId).toBeDefined();
    expect(sent.runId).not.toBe(first.runId);
    expect(detail.runs.find((run) => run.id === sent.runId)).toMatchObject({ mode: 'PREVIEW', sessionId: first.sessionId, status: 'RUNNING' });
    expect(waiting).toMatchObject({ status: 'QUEUED', sourceRunId: sent.runId });
    expect(scenario.agent.startedTurns.at(-1)!.prompt).toContain('Second');

    await scenario.service.stopPreviewAgent({ taskId: task.id });
    await scenario.waitForSnapshot((snapshot) => snapshot.runs.some((run) => run.id === sent.runId && run.status === 'INTERRUPTED'));
    expect((await scenario.store.getTaskDetail(task.id)).taskInstructions.find((item) => item.id === third.id)).toMatchObject({
      status: 'HELD', detail: 'Stopped. Send each message when you are ready.'
    });

    // Sending a held message by its id delivers it now.
    const resent = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: third.id, text: 'Third' });
    expect(resent).toMatchObject({ status: 'SUBMITTED', sessionId: first.sessionId });
    expect(scenario.agent.startedTurns).toHaveLength(3);
  });

  it('keeps one conversation per runtime and model and refuses a silently substituted model', async () => {
    const { scenario, task } = await previewScenario('preview-agent-models');
    const first = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Hello' });
    await scenario.completeRun(first.runId!);
    const same = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Again', settings: { model: 'scenario-model' } });
    expect(same.sessionId).toBe(first.sessionId);
    await scenario.completeRun(same.runId!);
    await expect(scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Other', settings: { model: 'other-model' } }))
      .rejects.toThrow('did not resolve the selected Preview model');
    expect((await scenario.store.getTaskDetail(task.id)).taskInstructions.filter((item) => item.role === 'PREVIEW' && item.status === 'FAILED')).toEqual([]);
    await expect(scenario.service.updateAppSettings({ previewRecipeGenerationRuntimeId: scenario.agent.descriptor.id, previewRecipeGenerationModel: 'other-model' }))
      .rejects.toThrow('did not resolve the selected Preview model');
  });

  it('keeps Preview messages queued when the main task agent is stopped', async () => {
    const { scenario, task } = await previewScenario('preview-agent-independent-queue');
    const primary = await scenario.service.startRun({ taskId: task.id });
    const preview = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Inspect the configuration.' });
    const queued = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Explain the requirements.' });
    await scenario.service.cancelRun({ runId: primary.id });
    expect((await scenario.store.getTaskDetail(task.id)).taskInstructions.find((item) => item.id === queued.id)?.status).toBe('QUEUED');
    await scenario.completeRun(preview.runId!);
    await scenario.waitForSnapshot((snapshot) => snapshot.taskInstructions.some((item) => item.id === queued.id && item.status === 'SUBMITTED'));
  });

  it('accepts a Preview conversation on another runtime than the task and keeps the task readable', async () => {
    const { scenario, task, worktree } = await previewScenario('preview-agent-other-runtime');
    const iteration = (await scenario.store.getCurrentIteration(task.id))!;
    const session = await scenario.createSession({ task, iteration, worktree, runtimeId: 'opencode', role: 'PREVIEW' });
    expect(session).toMatchObject({ role: 'PREVIEW', runtimeId: 'opencode' });
    const detail = await scenario.store.getTaskDetail(task.id);
    expect(detail.agentSessions.find((candidate) => candidate.id === session.id)).toMatchObject({ role: 'PREVIEW' });
    expect(detail.task.runtimeId).toBe('codex');
    expect(detail.task.currentAgentSessionId).toBeUndefined();
    await expect(scenario.service.getBoardSnapshot()).resolves.toBeTruthy();
  });

  it('refuses the Preview agent for a disabled runtime and keeps the message retryable', async () => {
    const { scenario, task } = await previewScenario('preview-agent-disabled-runtime');
    const internals = scenario.service as unknown as { appSettings: Record<string, unknown> };
    internals.appSettings = { ...internals.appSettings, disabledRuntimeIds: [scenario.agent.descriptor.id] };
    const id = randomUUID();
    await expect(scenario.service.sendPreviewAgentMessage({ taskId: task.id, id, text: 'Hello' })).rejects.toThrow('disabled');
    expect(scenario.agent.startedTurns).toHaveLength(0);
    expect((await scenario.store.getTaskDetail(task.id)).taskInstructions).toEqual([]);
  });

  it('rejects proposals and holds the queue when files change during Preview analysis, preserving the changes', async () => {
    const { scenario, task, worktree } = await previewScenario('preview-agent-changed-files');
    const first = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Inspect only.' });
    const queued = await scenario.service.sendPreviewAgentMessage({ taskId: task.id, id: randomUUID(), text: 'Then propose.' });
    await fs.writeFile(path.join(worktree.worktreePath, 'server.mjs'), '// unexpected change\n');
    await expect(bridgeOf(scenario).invoke({
      tool: 'propose_preview_configuration', runId: first.runId!,
      arguments: { yaml: PROPOSAL_YAML, summary: 'Runs the server.' }
    })).rejects.toThrow(/changed during/i);
    await scenario.completeRun(first.runId!);
    await scenario.waitForSnapshot((snapshot) => snapshot.taskInstructions.some((item) => item.id === queued.id && item.status === 'HELD'));
    expect((await scenario.store.getRun(first.runId!))?.status).toBe('FAILED');
    expect(scenario.agent.startedTurns).toHaveLength(1);
    expect(await fs.readFile(path.join(worktree.worktreePath, 'server.mjs'), 'utf8')).toBe('// unexpected change\n');
    expect((await scenario.service.getPreviewRecipeGeneration({ taskId: task.id })).status).toBe('EMPTY');
  });

  (process.platform === 'darwin' ? it : it.skip)('lets a repository Design without preview.yaml draft and save one through its detached Preview conversation', async () => {
    const scenario = await scenarioRegistry.create({ name: 'preview-agent-design-setup', designMode: true, previewEnabled: true });
    await scenario.commitFile('package.json', JSON.stringify({ scripts: { dev: 'node server.mjs' } }));
    await scenario.commitFile('server.mjs', 'import http from "node:http"; http.createServer().listen(Number(process.env.PORT));\n');
    const base = (await scenario.service.inspectDesignRepository({ repositoryId: scenario.repositoryId })).bases[0]!;
    let detail = await scenario.service.createDesign({ brief: 'Improve the home page.', creationToken: 'preview-agent-design-setup', runtimeId: 'codex',
      source: { kind: 'EXISTING_REPOSITORY', repositoryId: scenario.repositoryId, baseRef: base.refName, expectedBaseSha: base.sha } });
    const designId = detail.task.id;
    const workspace = detail.currentWorktree!.worktreePath;
    expect(detail.repositorySetup?.blocker).toBe('Save a preview.yaml configuration before starting Design.');
    const before = detail.task;

    const message = await scenario.service.sendPreviewAgentMessage({ taskId: designId, id: randomUUID(), text: 'Draft a preview configuration.' });
    expect(message).toMatchObject({ role: 'PREVIEW', status: 'SUBMITTED' });
    expect(scenario.agent.startedTurns.at(-1)).toMatchObject({ mode: 'PREVIEW', instructionProfile: 'PREVIEW' });
    detail = await scenario.service.getDesign(designId);
    // The conversation is the Design's own, beside its work: no phase, run or session binding, and no Design turn.
    expect([detail.task.workflowPhase, detail.task.currentRunId, detail.task.currentAgentSessionId])
      .toEqual([before.workflowPhase, before.currentRunId, before.currentAgentSessionId]);
    expect(detail.turns).toHaveLength(1);
    expect([detail.turns[0]?.runId, detail.turns[0]?.outcome]).toEqual([undefined, undefined]);
    expect(detail.previewAgent?.runs.map((run) => [run.id, run.mode])).toEqual([[message.runId, 'PREVIEW']]);
    expect(detail.previewAgent?.instructions.map((item) => item.id)).toEqual([message.id]);
    // Messages queue behind the turn and can be removed, as on a task.
    const queued = await scenario.service.sendPreviewAgentMessage({ taskId: designId, id: randomUUID(), text: 'Then explain it.' });
    expect(queued).toMatchObject({ status: 'QUEUED', sourceRunId: message.runId });
    await scenario.service.editTaskInstruction({ taskId: designId, id: queued.id });
    expect((await scenario.service.getDesign(designId)).previewAgent?.instructions.map((item) => item.id)).toEqual([message.id]);

    // The agent's question belongs to the Preview conversation, never to the Design conversation.
    const run = (await scenario.store.getRun(message.runId!))!;
    const server = await scenario.runtimeStore.createAgentServer({ runtimeId: run.runtimeId, runtimeKind: 'APP_SERVER', transport: 'STDIO', executable: 'scenario', argv: [] });
    await scenario.transitionRun(run.id, { status: 'RUNNING', serverInstanceId: server.id });
    const question = await scenario.taskRuntime.createInteractionRequest({
      runtimeId: run.runtimeId, serverInstanceId: server.id, providerRequestId: 1,
      taskId: designId, iterationId: run.iterationId, runId: run.id, sessionId: run.sessionId,
      type: 'USER_INPUT', request: { questions: [{ id: 'backend', header: 'Backend', question: 'Use a local backend?', isOther: true, isSecret: false }] },
      allowedActions: ['ANSWER'], policyWarnings: [], requestRawMessage: await scenario.runtimeStore.appendProtocolMessage(server.id, 'INBOUND', '{"id":1}')
    }, 'design-preview-question');
    detail = await scenario.service.getDesign(designId);
    expect(detail.interactions).toEqual([]);
    expect(detail.previewAgent?.interactions.map((item) => item.id)).toEqual([question.id]);
    await scenario.taskRuntime.transitionInteractionRequest(question.id, 'PENDING', {
      status: 'STALE', respondedAt: new Date().toISOString(),
      decision: { interactionType: 'USER_INPUT', action: 'ANSWER', answers: { backend: ['No backend.'] } }
    }, 'design-preview-answer');
    await scenario.transitionRun(run.id, { status: 'RUNNING' });

    const proposed = await bridgeOf(scenario).invoke({
      tool: 'propose_preview_configuration', runId: message.runId!,
      arguments: { yaml: PROPOSAL_YAML, summary: 'Runs the Node server.' }
    });
    expect(proposed.text).toMatch(/^Accepted\./);
    await scenario.completeRun(message.runId!, 'Proposed preview.yaml.');
    const generation = await scenario.service.getPreviewRecipeGeneration({ taskId: designId });
    expect(generation.status).toBe('READY');
    await expect(fs.access(path.join(workspace, 'preview.yaml'))).rejects.toThrow();

    // Saving writes the file into the Design workspace without approving or starting the application.
    await expect(scenario.service.acceptPreviewRecipeDraft({ taskId: designId, draftId: generation.draft!.id, yaml: generation.draft!.yaml }))
      .resolves.toEqual({ recipePath: 'preview.yaml' });
    expect(await fs.readFile(path.join(workspace, 'preview.yaml'), 'utf8')).toBe(PROPOSAL_YAML);
    const application = await scenario.service.getApplicationPreview({ taskId: designId });
    expect([application.status?.active, application.status?.candidate, application.approval]).toEqual([undefined, undefined, undefined]);
    // The queued Design turn now proceeds to the next setup step instead of waiting for a file.
    detail = await scenario.service.getDesign(designId);
    expect(detail.repositorySetup).toMatchObject({ blocker: 'Select the application to design.' });
    expect(detail.repositorySetup?.workspaceChanged).toBeFalsy();
    expect(detail.task.workflowPhase).toBe(before.workflowPhase);

    // The Design's Preview conversation is durable state the next launch accepts.
    const profileRoot = scenario.persistence.paths.profileRoot;
    await scenario.service.shutdown();
    await scenario.persistence.close();
    const reopened = await openTestPersistence(profileRoot);
    try {
      expect((await reopened.tasks.getDesignDetail(designId)).previewAgent?.instructions.map((item) => item.id)).toEqual([message.id]);
    } finally {
      await reopened.close();
    }
  }, 30_000);

});
