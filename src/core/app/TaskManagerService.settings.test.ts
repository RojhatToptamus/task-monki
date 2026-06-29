import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';

describe('TaskManagerService app settings', () => {
  it('uses persisted Codex external tool settings before provider startup', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-service-'));
    const repoDir = path.join(dir, 'repo');
    const storeDir = path.join(dir, 'store');
    await fs.mkdir(repoDir, { recursive: true });
    const executable = path.join(dir, 'fake-codex.js');
    await fs.writeFile(executable, fakeCodexScript(), { mode: 0o700 });

    const store = new FileTaskStore(storeDir);
    await store.updateAppSettings({
      codexExternalTools: {
        webSearchMode: 'cached',
        mcpServers: 'all',
        apps: 'enabled'
      }
    });

    const service = new TaskManagerService(store, repoDir, undefined, {
      codexPath: executable,
      worktreeRoot: path.join(dir, 'worktrees')
    });
    await service.init();
    try {
      const snapshot = await store.snapshot();
      expect(snapshot.agentServers[0]?.argv).toEqual([
        'app-server',
        '--stdio',
        '-c',
        'features.apps=true',
        '-c',
        'web_search="cached"'
      ]);
    } finally {
      await service.shutdown();
    }
  });

  it('defers provider restart while a run requires recovery', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-settings-recovery-'));
    const repoDir = path.join(dir, 'repo');
    const storeDir = path.join(dir, 'store');
    await fs.mkdir(repoDir, { recursive: true });
    const executable = path.join(dir, 'fake-codex.js');
    await fs.writeFile(executable, fakeCodexScript(), { mode: 0o700 });

    const store = new FileTaskStore(storeDir);
    const service = new TaskManagerService(store, repoDir, undefined, {
      codexPath: executable,
      worktreeRoot: path.join(dir, 'worktrees')
    });
    await service.init();
    try {
      const task = await store.createTask({
        title: 'Recovery settings guard',
        prompt: 'Keep recovery state stable.',
        repositoryPath: repoDir
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: 'codex/recovery-settings-guard',
        worktreePath: path.join(dir, 'worktree'),
        baseSha: 'base'
      });
      const session = await store.createAgentSession({
        task,
        iteration,
        worktree,
        provider: 'codex'
      });
      const run = await store.createRun({
        task,
        session,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt
      });
      await store.updateRun(run.id, { status: 'RECOVERY_REQUIRED' });

      await service.updateAppSettings({
        codexExternalTools: {
          webSearchMode: 'live',
          mcpServers: 'all',
          apps: 'enabled'
        }
      });

      const snapshot = await store.snapshot();
      expect(snapshot.agentServers).toHaveLength(1);
      expect((await service.getAgentProviderState()).preflight.warnings).toContain(
        'Codex external tool settings will apply after the App Server restarts.'
      );
    } finally {
      await service.shutdown();
    }
  });
});

function fakeCodexScript(): string {
  return `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.141.0\\n');
  process.exit(0);
}
if (process.argv[2] === 'mcp' && process.argv[3] === 'list' && process.argv.includes('--json')) {
  process.stdout.write('[{"name":"docs","enabled":true,"transport":{"type":"stdio","command":"docs-mcp"}}]\\n');
  process.exit(0);
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.id || !message.method) return;
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: {
        userAgent: 'fake',
        codexHome: process.cwd(),
        platformFamily: 'unix',
        platformOs: 'macos'
      } });
      break;
    case 'account/read':
      send({ id: message.id, result: {
        account: { type: 'apiKey' },
        requiresOpenaiAuth: false
      } });
      break;
    case 'model/list':
      send({ id: message.id, result: {
        data: [{
          id: 'fake-model',
          model: 'fake-model',
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: 'Fake Model',
          description: 'Test model',
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Low' },
            { reasoningEffort: 'high', description: 'High' }
          ],
          defaultReasoningEffort: 'high',
          inputModalities: ['text'],
          supportsPersonality: false,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: true
        }],
        nextCursor: null
      } });
      break;
    default:
      send({ id: message.id, error: { message: 'unsupported ' + message.method } });
  }
});
`;
}
