import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  AgentCommandApprovalRequest,
  AgentInteractionDecision,
  AgentPermissionApprovalRequest,
  AgentUserInputRequest,
  InteractionRequestRecord
} from '../../shared/contracts';
import { AppEventBus } from '../runner/AppEventBus';
import { git } from '../git/gitCli';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { TaskManagerService } from './TaskManagerService';

/**
 * Opt-in live qualification of the Preview conversation with an installed,
 * authenticated provider. It spends provider usage, so it runs only when
 * TASK_MONKI_REAL_PREVIEW_RUNTIME names a runtime (for example `opencode` or
 * `claude-agent-acp`); TASK_MONKI_REAL_PREVIEW_MODEL and
 * TASK_MONKI_REAL_PREVIEW_MODEL_PROVIDER select the model.
 */
const runtimeId = process.env.TASK_MONKI_REAL_PREVIEW_RUNTIME;
const model = process.env.TASK_MONKI_REAL_PREVIEW_MODEL;
const modelProvider = process.env.TASK_MONKI_REAL_PREVIEW_MODEL_PROVIDER;
const TURN_TIMEOUT_MS = 8 * 60_000;

describe.skipIf(!runtimeId)('Preview agent with a live provider', () => {
  it('asks a question, uses its app tool, and reads an external folder only after consent', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-live-preview-')));
    const repositoryPath = path.join(root, 'frontend');
    const backend = path.join(root, 'backend');
    const backendName = `live-backend-${randomUUID().slice(0, 8)}`;
    await fs.mkdir(repositoryPath);
    await fs.mkdir(backend);
    await fs.writeFile(path.join(backend, 'package.json'), JSON.stringify({ name: backendName, scripts: { start: 'node api.mjs' } }));
    await git(repositoryPath, ['init', '-b', 'main']);
    await git(repositoryPath, ['config', 'user.email', 'task-monki@example.invalid']);
    await git(repositoryPath, ['config', 'user.name', 'Task Monki']);
    await fs.writeFile(path.join(repositoryPath, 'package.json'), JSON.stringify({ name: 'live-frontend', scripts: { dev: 'node server.mjs' } }));
    await fs.writeFile(path.join(repositoryPath, 'server.mjs'), 'import http from "node:http"; http.createServer().listen(Number(process.env.PORT));\n');
    await git(repositoryPath, ['add', '.']);
    await git(repositoryPath, ['commit', '-m', 'Initial commit']);

    const persistence = await openTestPersistence(path.join(root, 'profile'));
    const service = new TaskManagerService(persistence.tasks, repositoryPath, new AppEventBus(), {
      worktreeRoot: path.join(root, 'worktrees'),
      agentCwd: repositoryPath,
      appSettingsStore: persistence.settings,
      agentRuntimeStore: persistence.agentRuntime,
      taskRuntimeAccess: persistence.taskRuntime,
      previewEnabled: true,
      previewRoot: path.join(root, 'preview-runtime')
    });
    const decisions: string[] = [];
    try {
      await service.init();
      const repository = await service.addRepository(repositoryPath);
      const settings = { runtimeId: runtimeId!, ...(model ? { model } : {}), ...(modelProvider ? { modelProvider } : {}) };
      const task = await service.createTask({
        title: 'Live Preview qualification', prompt: 'Qualify the Preview agent.', repositoryId: repository.id,
        runtimeId: runtimeId!, agentSettings: settings
      });
      const worktree = await prepareTestWorktree(service, task.id);
      const message = await service.sendPreviewAgentMessage({
        taskId: task.id,
        id: randomUUID(),
        settings,
        text: [
          'This is a tool qualification; follow these steps exactly and do not propose a configuration.',
          '1. Ask me with your structured question tool whether the backend is "external URL" or "local folder" (offer exactly those two options).',
          '2. Call the inspect_preview tool with what "status".',
          `3. Read the file ${path.join(backend, 'package.json')} with your file-reading tool and tell me its "name" value.`,
          'Read files only; do not write files, install anything, or run the application.'
        ].join('\n')
      });
      const runId = message.runId!;
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      for (;;) {
        const run = (await persistence.tasks.getTaskDetail(task.id)).runs.find((candidate) => candidate.id === runId)!;
        if (['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST', 'RECOVERY_REQUIRED'].includes(run.status)) break;
        const pending = (await persistence.taskRuntime.snapshot()).interactionRequests.find(
          (item) => item.runId === runId && item.status === 'PENDING'
        );
        if (pending) {
          const decision = decide(pending, backend);
          decisions.push(`${pending.type}:${decision.action}:${JSON.stringify(pending.type === 'PERMISSION_APPROVAL' ? (pending.request as AgentPermissionApprovalRequest).permissions : pending.request).slice(0, 600)}`);
          await service.respondToInteraction({ taskId: task.id, runId, interactionRequestId: pending.id, decision });
        }
        if (Date.now() > deadline) throw new Error(`The live Preview turn did not finish. Decisions: ${decisions.join(' | ')}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const run = (await persistence.tasks.getTaskDetail(task.id)).runs.find((candidate) => candidate.id === runId)!;
      const items = await persistence.taskRuntime.getAgentItemsForRun(runId);
      const report = {
        status: run.status,
        settings: run.requestedSettings,
        decisions,
        items: items.map((item) => `${item.type}:${item.status}:${JSON.stringify(item.payload).slice(0, 240)}`)
      };
      console.info(JSON.stringify(report, null, 2));
      expect(run.status).toBe('COMPLETED');
      expect(decisions.some((entry) => entry.startsWith('USER_INPUT:ANSWER'))).toBe(true);
      expect(decisions.some((entry) => entry.startsWith('PERMISSION_APPROVAL:GRANT_TURN'))).toBe(true);
      expect(decisions.filter((entry) => /^(COMMAND|FILE_CHANGE)_APPROVAL/u.test(entry))).toEqual([]);
      // ACP and OpenCode reach app tools through MCP; Codex receives them as dynamic tools.
      expect(items.some((item) => (item.type === 'MCP_TOOL_CALL' || item.type === 'DYNAMIC_TOOL_CALL') && item.status === 'COMPLETED' &&
        JSON.stringify(item.payload).includes('inspect_preview'))).toBe(true);
      expect(items.filter((item) => item.type === 'AGENT_MESSAGE').map((item) => JSON.stringify(item.payload)).join('\n'))
        .toContain(backendName);
      expect((await git(worktree.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()).toBe('');
    } finally {
      await service.shutdown();
      await persistence.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, TURN_TIMEOUT_MS + 120_000);
});

/** Answers the question, grants reads inside the backend folder only, and declines everything else. */
function decide(interaction: InteractionRequestRecord, backend: string): AgentInteractionDecision {
  switch (interaction.type) {
    case 'USER_INPUT': {
      const request = interaction.request as AgentUserInputRequest;
      return {
        interactionType: 'USER_INPUT',
        action: 'ANSWER',
        answers: Object.fromEntries(request.questions.map((question) => [
          question.id,
          [question.options?.find((option) => /local/iu.test(option.label))?.label ?? question.options?.[0]?.label ?? 'local folder']
        ]))
      };
    }
    case 'PERMISSION_APPROVAL': {
      const request = interaction.request as AgentPermissionApprovalRequest;
      const entries = request.permissions.fileSystem?.entries ?? [];
      const insideBackend = entries.length > 0 && !request.permissions.network?.enabled &&
        !request.permissions.fileSystem?.write?.length &&
        entries.every((entry) => {
          const target = entry.path as { path?: unknown };
          return entry.access === 'read' && typeof target?.path === 'string' &&
            (target.path === backend || target.path.startsWith(`${backend}${path.sep}`));
        });
      return insideBackend && interaction.allowedActions.includes('GRANT_TURN')
        ? { interactionType: 'PERMISSION_APPROVAL', action: 'GRANT_TURN', permissions: request.permissions }
        : { interactionType: 'PERMISSION_APPROVAL', action: 'DECLINE' };
    }
    case 'COMMAND_APPROVAL': {
      const option = (interaction.request as AgentCommandApprovalRequest).providerOptions
        ?.find((candidate) => candidate.action === 'DECLINE');
      if (option) return { interactionType: 'COMMAND_APPROVAL', action: 'DECLINE', providerOptionId: option.id };
      return { interactionType: 'COMMAND_APPROVAL', action: interaction.allowedActions.includes('DECLINE') ? 'DECLINE' : 'CANCEL' };
    }
    case 'FILE_CHANGE_APPROVAL':
      return { interactionType: 'FILE_CHANGE_APPROVAL', action: 'DECLINE' };
    case 'MCP_ELICITATION':
      return { interactionType: 'MCP_ELICITATION', action: 'DECLINE' };
    case 'DYNAMIC_TOOL':
      return { interactionType: 'DYNAMIC_TOOL', action: 'REJECT_UNREGISTERED' };
  }
}
