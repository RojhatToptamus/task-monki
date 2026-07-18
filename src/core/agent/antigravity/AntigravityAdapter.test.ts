import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionSettings, AgentSessionRecord, RunRecord } from '../../../shared/contracts';
import { writeNodeExecutable } from '../../../testSupport/fakeExecutable';
import { AppEventBus } from '../../runner/AppEventBus';
import { createDomainEvent } from '../../storage/domainEvent';
import {
  ProcessSupervisor,
  type ProcessSpec,
  type SupervisedProcess
} from '../../process/ProcessSupervisor';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { AgentOrchestrator } from '../AgentOrchestrator';
import { AgentRuntimeRegistry } from '../AgentRuntimeRegistry';
import { AntigravityAdapter } from './AntigravityAdapter';
import {
  ANTIGRAVITY_ENVIRONMENT_POLICY,
  ANTIGRAVITY_MACOS_XPC_SERVICE_NAME,
  antigravityChildEnvironment
} from './AntigravityEnvironmentPolicy';
import type { ResolvedAntigravityRuntime } from './AntigravityRuntimeResolver';

const SETTINGS: AgentExecutionSettings = {
  runtimeId: 'antigravity',
  modelProvider: 'google',
  model: 'Gemini 3.5 Flash (Low)',
  sandbox: 'WORKSPACE_WRITE',
  networkAccess: true,
  approvalPolicy: 'provider-terminal-policy',
  approvalsReviewer: 'user'
};
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('AntigravityAdapter', () => {
  it.runIf(process.platform === 'darwin')('supplies the reviewed macOS service identity for catalog discovery without caller injection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-antigravity-env-'));
    directories.push(root);
    const executable = await writeNodeExecutable(
      root,
      'agy',
      [
        "const argv = process.argv.slice(2);",
        "if (argv[0] !== 'models') process.exit(9);",
        "if (process.env.TASK_MONKI_UNRELATED_SECRET) process.exit(8);",
        `if (process.env.XPC_SERVICE_NAME !== ${JSON.stringify(ANTIGRAVITY_MACOS_XPC_SERVICE_NAME)}) {`,
        "  process.stderr.write('Please sign in to view available models.');",
        '  process.exit(7);',
        '}',
        "process.stdout.write('Gemini 3.5 Flash (Low)\\n');"
      ].join('\n')
    );
    const adapter = new AntigravityAdapter(
      new FileTaskStore(path.join(root, 'store')),
      new AppEventBus(),
      {
        cwd: root,
        executable,
        environment: {
          PATH: process.env.PATH,
          XPC_SERVICE_NAME: 'ambient-value-must-not-win',
          CODEX_HOME: '/must-not-pass/codex-home',
          TASK_MONKI_UNRELATED_SECRET: 'must-not-pass'
        },
        runtimeResolver: async () => resolvedRuntime(executable)
      }
    );

    expect(ANTIGRAVITY_ENVIRONMENT_POLICY.contractId).toBe(
      'task-monki/antigravity-environment@v3'
    );
    expect(ANTIGRAVITY_ENVIRONMENT_POLICY.allowedKeys).toContain(
      'XPC_SERVICE_NAME'
    );
    expect(await adapter.listModels()).toEqual([
      expect.objectContaining({ model: 'Gemini 3.5 Flash (Low)' })
    ]);
    await adapter.shutdown();
  });

  it('owns the macOS XPC value and omits macOS-only and Codex state on other platforms', () => {
    const source = {
      PATH: '/bin',
      XPC_SERVICE_NAME: 'ambient-value-must-not-win',
      CODEX_HOME: '/must-not-pass/codex-home'
    };

    expect(antigravityChildEnvironment(source, 'darwin')).toEqual({
      PATH: '/bin',
      XPC_SERVICE_NAME: ANTIGRAVITY_MACOS_XPC_SERVICE_NAME
    });
    expect(antigravityChildEnvironment(source, 'linux')).toEqual({ PATH: '/bin' });
    expect(antigravityChildEnvironment(source, 'win32')).toEqual({ PATH: '/bin' });
  });

  it('reports bounded redacted catalog stderr once and retries on a later refresh', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-antigravity-retry-'));
    directories.push(root);
    const marker = path.join(root, 'catalog-attempted');
    const providerSecret = 'https://catalog-user:catalog-secret@example.invalid';
    const executable = await writeNodeExecutable(
      root,
      'agy',
      [
        "const fs = require('node:fs');",
        `const marker = ${JSON.stringify(marker)};`,
        "if (process.argv[2] !== 'models') process.exit(9);",
        'if (!fs.existsSync(marker)) {',
        "  fs.writeFileSync(marker, 'attempted');",
        `  process.stderr.write(${JSON.stringify(`Please sign in. proxy=${providerSecret}\n${'x'.repeat(24 * 1024)}`)});`,
        '  process.exit(7);',
        '}',
        "process.stdout.write('Gemini 3.5 Flash (Low)\\n');"
      ].join('\n')
    );
    const adapter = new AntigravityAdapter(
      new FileTaskStore(path.join(root, 'store')),
      new AppEventBus(),
      {
        cwd: root,
        executable,
        environment: { PATH: process.env.PATH, HTTPS_PROXY: providerSecret },
        runtimeResolver: async () => resolvedRuntime(executable)
      }
    );
    const registry = new AgentRuntimeRegistry([adapter], 'antigravity');

    expect(await registry.initializeAll()).toHaveLength(1);
    const failed = (await registry.getCatalog()).runtimes[0]!.preflight.readiness;
    expect(failed.status).toBe('AUTHENTICATION_REQUIRED');
    expect(failed.detail).toContain('Please sign in.');
    expect(failed.detail).not.toContain('catalog-secret');
    expect(Buffer.byteLength(failed.detail)).toBeLessThanOrEqual(16 * 1024);

    const recovered = await registry.getCatalog();
    expect(recovered.runtimes[0]!.preflight.readiness.status).toBe('READY');
    expect(recovered.models).toEqual([
      expect.objectContaining({ model: 'Gemini 3.5 Flash (Low)' })
    ]);
    await registry.shutdownAll();
  });

  it('refreshes an expired successful catalog once for concurrent registry reads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-antigravity-ttl-'));
    directories.push(root);
    const invocations = path.join(root, 'model-invocations');
    const executable = await writeNodeExecutable(
      root,
      'agy',
      [
        "const fs = require('node:fs');",
        `const invocations = ${JSON.stringify(invocations)};`,
        "if (process.argv[2] !== 'models') process.exit(9);",
        "fs.appendFileSync(invocations, 'model-read\\n');",
        "const count = fs.readFileSync(invocations, 'utf8').trim().split('\\n').length;",
        "const catalog = count === 1 ? 'Gemini 3.5 Flash (Low)\\n' : 'Gemini 3.5 Flash (Low)\\nClaude Sonnet 4.6 (Thinking)\\n';",
        'setTimeout(() => process.stdout.write(catalog), 60);'
      ].join('\n')
    );
    const adapter = new AntigravityAdapter(
      new FileTaskStore(path.join(root, 'store')),
      new AppEventBus(),
      {
        cwd: root,
        executable,
        modelCatalogTtlMs: 15,
        runtimeResolver: async () => resolvedRuntime(executable)
      }
    );
    const registry = new AgentRuntimeRegistry([adapter], 'antigravity');

    await adapter.initialize();
    await expect(adapter.readNativeState()).resolves.toMatchObject({
      models: [expect.objectContaining({ label: 'Gemini 3.5 Flash (Low)' })]
    });
    expect((await fs.readFile(invocations, 'utf8')).trim().split('\n')).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const catalogs = await Promise.all([
      registry.getCatalog(),
      registry.getCatalog(),
      registry.getCatalog()
    ]);
    for (const catalog of catalogs) {
      expect(catalog.models.map((model) => model.model)).toEqual([
        'Gemini 3.5 Flash (Low)',
        'Claude Sonnet 4.6 (Thinking)'
      ]);
    }
    expect((await fs.readFile(invocations, 'utf8')).trim().split('\n')).toHaveLength(2);
    await registry.shutdownAll();
  });

  it('fails an expired catalog read closed instead of returning stale models', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-antigravity-stale-'));
    directories.push(root);
    const invocations = path.join(root, 'model-invocations');
    const executable = await writeNodeExecutable(
      root,
      'agy',
      [
        "const fs = require('node:fs');",
        `const invocations = ${JSON.stringify(invocations)};`,
        "if (process.argv[2] !== 'models') process.exit(9);",
        "fs.appendFileSync(invocations, 'model-read\\n');",
        "const count = fs.readFileSync(invocations, 'utf8').trim().split('\\n').length;",
        "if (count === 1) process.stdout.write('Gemini 3.5 Flash (Low)\\n');",
        "else { process.stderr.write('catalog refresh failed'); process.exit(7); }"
      ].join('\n')
    );
    const adapter = new AntigravityAdapter(
      new FileTaskStore(path.join(root, 'store')),
      new AppEventBus(),
      {
        cwd: root,
        executable,
        modelCatalogTtlMs: 10,
        runtimeResolver: async () => resolvedRuntime(executable)
      }
    );
    const registry = new AgentRuntimeRegistry([adapter], 'antigravity');

    await adapter.initialize();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const catalog = await registry.getCatalog();
    expect(catalog.models).toEqual([]);
    expect(catalog.runtimes[0]?.models).toEqual([]);
    expect(catalog.runtimes[0]?.preflight.readiness).toMatchObject({
      status: 'FAILED',
      canStart: false,
      checks: { modelCatalog: 'FAILED' }
    });
    await registry.shutdownAll();
  });

  it('aborts and awaits catalog discovery on shutdown without late model mutation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-antigravity-shutdown-catalog-'));
    directories.push(root);
    const invocations = path.join(root, 'model-invocations');
    const executable = await writeNodeExecutable(
      root,
      'agy',
      [
        "const fs = require('node:fs');",
        `const invocations = ${JSON.stringify(invocations)};`,
        "if (process.argv[2] !== 'models') process.exit(9);",
        "fs.appendFileSync(invocations, 'model-read\\n');",
        "const count = fs.readFileSync(invocations, 'utf8').trim().split('\\n').length;",
        "if (count === 1) process.stdout.write('Gemini 3.5 Flash (Low)\\n');",
        "else setTimeout(() => process.stdout.write('Claude Sonnet 4.6 (Thinking)\\n'), 2_000);"
      ].join('\n')
    );
    const events = new AppEventBus();
    const runtimeUpdates: unknown[] = [];
    events.on((event) => {
      if (event.type === 'runtime.updated') runtimeUpdates.push(event);
    });
    const adapter = new AntigravityAdapter(
      new FileTaskStore(path.join(root, 'store')),
      events,
      {
        cwd: root,
        executable,
        modelCatalogTtlMs: 10,
        runtimeResolver: async () => resolvedRuntime(executable)
      }
    );

    await adapter.initialize();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const refresh = adapter.listModels();
    const refreshRejection = expect(refresh).rejects.toThrow(
      'Antigravity model catalog discovery failed'
    );
    await waitForFileLineCount(invocations, 2);
    const updatesBeforeShutdown = runtimeUpdates.length;

    await adapter.shutdown();
    await refreshRejection;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(adapter.readNativeState()).resolves.toMatchObject({
      models: [
        expect.objectContaining({ label: 'Gemini 3.5 Flash (Low)' })
      ]
    });
    expect(runtimeUpdates).toHaveLength(updatesBeforeShutdown);
  });

  it('forces one bounded refresh when an exact selected label is absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-antigravity-selection-'));
    directories.push(root);
    const invocations = path.join(root, 'model-invocations');
    const executable = await writeNodeExecutable(
      root,
      'agy',
      [
        "const fs = require('node:fs');",
        `const invocations = ${JSON.stringify(invocations)};`,
        "if (process.argv[2] !== 'models') process.exit(9);",
        "fs.appendFileSync(invocations, 'model-read\\n');",
        "const count = fs.readFileSync(invocations, 'utf8').trim().split('\\n').length;",
        "const catalog = count === 1 ? 'Gemini 3.5 Flash (Low)\\n' : 'Gemini 3.5 Flash (Low)\\nClaude Sonnet 4.6 (Thinking)\\n';",
        'setTimeout(() => process.stdout.write(catalog), 40);'
      ].join('\n')
    );
    const adapter = new AntigravityAdapter(
      new FileTaskStore(path.join(root, 'store')),
      new AppEventBus(),
      {
        cwd: root,
        executable,
        modelCatalogTtlMs: 60_000,
        runtimeResolver: async () => resolvedRuntime(executable)
      }
    );

    await adapter.initialize();
    const resolved = await adapter.resolveExecution({
      settings: {
        ...SETTINGS,
        modelProvider: 'anthropic',
        model: 'Claude Sonnet 4.6 (Thinking)'
      },
      attachments: []
    });
    expect(resolved.model).toMatchObject({
      modelProvider: 'anthropic',
      model: 'Claude Sonnet 4.6 (Thinking)'
    });
    expect((await fs.readFile(invocations, 'utf8')).trim().split('\n')).toHaveLength(2);

    await expect(
      adapter.resolveExecution({
        settings: {
          ...SETTINGS,
          modelProvider: 'anthropic',
          model: 'Claude Missing'
        },
        attachments: []
      })
    ).rejects.toThrow('Antigravity did not advertise model Claude Missing');
    expect((await fs.readFile(invocations, 'utf8')).trim().split('\n')).toHaveLength(3);
    await adapter.shutdown();
  });

  it('discovers every exact label and launches a turn with its runtime-owned environment and safe flags', async () => {
    const fixture = await createFixture(true, {
      environment: {
        PATH: process.env.PATH,
        XPC_SERVICE_NAME: 'ambient-value-must-not-win',
        CODEX_HOME: '/must-not-pass/codex-home'
      }
    });
    const alias = path.join(fixture.root, 'worktree-alias');
    await fs.symlink(
      fixture.worktree.worktreePath,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await fixture.store.updateAgentSession(fixture.session.id, { status: 'NOT_MATERIALIZED' });
    const materialized = await fixture.adapter.createSession({
      runtimeId: 'antigravity',
      localSessionId: fixture.session.id,
      taskId: fixture.task.id,
      iterationId: fixture.iteration.id,
      worktreeId: fixture.worktree.id,
      worktreePath: alias,
      settings: SETTINGS
    });
    expect(materialized.providerSessionId).toBeUndefined();
    expect((await fixture.adapter.listModels()).map((model) => model.model)).toEqual([
      'Gemini 3.5 Flash (Low)',
      'Claude Sonnet 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)'
    ]);
    expect((await fixture.adapter.preflight()).readiness.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'PROMPT_VISIBLE_IN_PROCESS_ARGV',
        severity: 'WARNING',
        stage: 'SECURITY'
      })
    );
    expect(
      (await fixture.adapter.capabilities()).extensions.nonInteractivePrintMode
        ?.detail
    ).toContain('full prompt is visible in the live child argv');
    await expect(fixture.adapter.readNativeState()).resolves.toMatchObject({
      promptTransport: 'process-argv',
      promptDurableRecord: 'redacted'
    });

    const run = await createRun(fixture, materialized, 'SUCCESS');
    await fixture.adapter.startTurn(turnInput(run, materialized, 'SUCCESS'));
    const completed = await waitForRun(fixture.store, run.id, ['COMPLETED']);

    expect(completed.finalMessage).toBe('Antigravity completed SUCCESS');
    const invocation = JSON.parse(
      await fs.readFile(path.join(fixture.worktree.worktreePath, '.fake-agy-argv.json'), 'utf8')
    ) as string[];
    expect(invocation).toEqual(
      expect.arrayContaining([
        '--print',
        'SUCCESS',
        '--model',
        'Gemini 3.5 Flash (Low)',
        '--new-project',
        '--sandbox',
        '--print-timeout',
        '30m',
        '--mode',
        'accept-edits'
      ])
    );
    expect(invocation).not.toContain('--dangerously-skip-permissions');
    const childEnvironment = JSON.parse(
      await fs.readFile(path.join(fixture.worktree.worktreePath, '.fake-agy-env.json'), 'utf8')
    ) as { xpcServiceName?: string; codexHome?: string };
    expect(childEnvironment).toEqual(
      process.platform === 'darwin'
        ? { xpcServiceName: ANTIGRAVITY_MACOS_XPC_SERVICE_NAME }
        : {}
    );
    const snapshot = await fixture.store.snapshot();
    const server = snapshot.agentServers.find((candidate) => candidate.id === completed.serverInstanceId);
    expect(server?.argv).toContain('<prompt>');
    expect(server?.argv).not.toContain('SUCCESS');
    expect(await waitForSessionStatus(fixture.store, materialized.id, 'IDLE')).toBe(
      'IDLE'
    );
    expect(snapshot.agentSettingsObservations).toHaveLength(1);
    expect(snapshot.agentSettingsObservations[0]).toMatchObject({
      taskId: fixture.task.id,
      iterationId: fixture.iteration.id,
      sessionId: materialized.id,
      runId: run.id,
      runtimeId: 'antigravity',
      source: 'TASK_MONKI_RESOLUTION',
      settings: {
        runtimeId: 'antigravity',
        modelProvider: 'google',
        model: 'Gemini 3.5 Flash (Low)'
      }
    });
    expect(completed.observedSettings).toBeUndefined();
    expect((await fixture.store.getAgentSession(materialized.id))?.observedSettings).toBeUndefined();
    await fixture.adapter.shutdown();
  });

  it('uses plan mode for analysis and terminalizes non-zero exits as failed', async () => {
    const fixture = await createFixture();
    const run = await createRun(fixture, fixture.session, 'FAIL', 'ANALYSIS');
    await fixture.adapter.startTurn(
      turnInput(run, fixture.session, 'FAIL', 'ANALYSIS')
    );
    const failed = await waitForRun(fixture.store, run.id, ['FAILED']);
    expect(failed.terminalReason).toContain('simulated provider failure');
    const invocation = JSON.parse(
      await fs.readFile(path.join(fixture.worktree.worktreePath, '.fake-agy-argv.json'), 'utf8')
    ) as string[];
    expect(invocation).toEqual(expect.arrayContaining(['--mode', 'plan']));
    await fixture.adapter.shutdown();
  });

  it('requires an exact selected model because the catalog advertises no default', async () => {
    const fixture = await createFixture();

    await expect(
      fixture.adapter.resolveExecution({
        settings: { ...SETTINGS, model: undefined, modelProvider: undefined },
        attachments: []
      })
    ).rejects.toThrow('does not advertise a default model');
    await fixture.adapter.shutdown();
  });

  it('interrupts the owned process without requiring a provider session ID', async () => {
    const fixture = await createFixture();
    const run = await createRun(fixture, fixture.session, 'WAIT');
    const turn = await fixture.adapter.startTurn(turnInput(run, fixture.session, 'WAIT'));
    await fixture.adapter.interruptTurn({
      session: { localSessionId: fixture.session.id },
      providerTurnId: turn.providerTurnId!
    });

    const interrupted = await waitForRun(fixture.store, run.id, ['INTERRUPTED']);
    expect(interrupted.terminalReason).toContain('interrupted by the user');
    expect((await fixture.store.getAgentSession(fixture.session.id))?.status).toBe('IDLE');
    await fixture.adapter.shutdown();
  });

  it('keeps a natural completion when close is queued before interrupt', async () => {
    const process = new ControlledProcessSupervisor();
    const fixture = await createFixture(true, { processSupervisor: process });
    const run = await createRun(fixture, fixture.session, 'CONTROLLED');
    const turn = await fixture.adapter.startTurn(
      turnInput(run, fixture.session, 'CONTROLLED')
    );
    const blocked = blockNextInboundJournal(fixture.store, 'stdout');
    process.stdout('natural completion\n');
    await blocked.entered;
    process.close(0, null);

    const lookup = observeNextProviderTurnLookup(fixture.store);
    const interrupt = fixture.adapter.interruptTurn({
      session: { localSessionId: fixture.session.id },
      providerTurnId: turn.providerTurnId!
    });
    await lookup;
    await Promise.resolve();
    blocked.release();

    await expect(interrupt).rejects.toThrow('no longer active');
    const completed = await waitForRun(fixture.store, run.id, ['COMPLETED']);
    expect(completed.finalMessage).toBe('natural completion');
    expect(process.cancel).not.toHaveBeenCalled();
    await fixture.adapter.shutdown();
  });

  it('persists cancellation before a close queued by interrupt and terminalizes interrupted', async () => {
    const process = new ControlledProcessSupervisor();
    const fixture = await createFixture(true, { processSupervisor: process });
    const run = await createRun(fixture, fixture.session, 'CONTROLLED');
    const turn = await fixture.adapter.startTurn(
      turnInput(run, fixture.session, 'CONTROLLED')
    );
    process.stdout('partial output\n');
    const blocked = blockNextInterruptPersistence(fixture.store);
    const interrupt = fixture.adapter.interruptTurn({
      session: { localSessionId: fixture.session.id },
      providerTurnId: turn.providerTurnId!
    });
    await blocked.entered;
    process.close(0, null);
    blocked.release();

    await expect(interrupt).resolves.toBeUndefined();
    const interrupted = await waitForRun(fixture.store, run.id, ['INTERRUPTED']);
    expect(interrupted.terminalReason).toContain('interrupted by the user');
    expect(process.cancel).toHaveBeenCalledOnce();
    await fixture.adapter.shutdown();
  });

  it('keeps a natural completion when close is queued before shutdown', async () => {
    const process = new ControlledProcessSupervisor();
    const fixture = await createFixture(true, { processSupervisor: process });
    const run = await createRun(fixture, fixture.session, 'CONTROLLED');
    await fixture.adapter.startTurn(turnInput(run, fixture.session, 'CONTROLLED'));
    const blocked = blockNextInboundJournal(fixture.store, 'stdout');
    process.stdout('finished before shutdown\n');
    await blocked.entered;
    process.close(0, null);
    const shutdown = fixture.adapter.shutdown();
    blocked.release();

    await shutdown;
    const completed = await waitForRun(fixture.store, run.id, ['COMPLETED']);
    expect(completed.finalMessage).toBe('finished before shutdown');
    expect(process.cancel).not.toHaveBeenCalled();
  });

  it('settles shutdown into a permanent recovery fence when process termination is unconfirmed', async () => {
    const process = new ControlledProcessSupervisor();
    process.cancel.mockRejectedValueOnce(
      new Error('simulated process termination failure')
    );
    const fixture = await createFixture(true, { processSupervisor: process });
    const run = await createRun(fixture, fixture.session, 'CONTROLLED');
    await fixture.adapter.startTurn(turnInput(run, fixture.session, 'CONTROLLED'));
    const outputBeforeShutdown = await fixture.store.readArtifact(run.outputArtifactId);

    await expect(fixture.adapter.shutdown()).rejects.toThrow(
      'Antigravity runtime shutdown was incomplete'
    );

    const recovered = await waitForRecovery(fixture.store, run.id);
    expect((await fixture.store.getAgentSession(fixture.session.id))?.status).toBe('IDLE');
    const server = await fixture.store.getAgentServer(recovered.serverInstanceId!);
    expect(server?.status).toBe('LOST');
    expect(server?.exitedAt).toBeUndefined();
    expect((await fixture.adapter.preflight()).readiness).toMatchObject({
      status: 'FAILED',
      canStart: false,
      diagnostics: [
        expect.objectContaining({ code: 'PROCESS_TERMINATION_UNCONFIRMED' })
      ]
    });
    await expect(
      fixture.adapter.releaseSession({ localSessionId: fixture.session.id })
    ).resolves.toBeUndefined();

    process.stdout('late output from the unconfirmed process\n');
    process.close(0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await fixture.store.getRun(run.id))?.status).toBe('RECOVERY_REQUIRED');
    expect(await fixture.store.readArtifact(run.outputArtifactId)).toBe(
      outputBeforeShutdown
    );

    const retry = await createRun(fixture, fixture.session, 'CONTROLLED');
    await expect(
      fixture.adapter.startTurn(turnInput(retry, fixture.session, 'CONTROLLED'))
    ).rejects.toThrow('safety-fenced until Task Monki restarts');
    expect(process.cancel).toHaveBeenCalledOnce();
  });

  it('recovers the run and fences replacement when the owned process tree cannot be reaped', async () => {
    const process = new ControlledProcessSupervisor();
    const fixture = await createFixture(true, { processSupervisor: process });
    const run = await createRun(fixture, fixture.session, 'CONTROLLED');
    await fixture.adapter.startTurn(turnInput(run, fixture.session, 'CONTROLLED'));
    const outputBeforeFailure = await fixture.store.readArtifact(run.outputArtifactId);

    process.terminationUnconfirmed(new Error('simulated descendant termination failure'));

    const recovered = await waitForRecovery(fixture.store, run.id);
    expect((await fixture.store.getAgentSession(fixture.session.id))?.status).toBe('IDLE');
    const server = await fixture.store.getAgentServer(recovered.serverInstanceId!);
    expect(server).toEqual(
      expect.objectContaining({
        status: 'LOST',
        exitReason: expect.stringContaining('process termination is unconfirmed')
      })
    );
    expect(server?.exitedAt).toBeUndefined();
    expect((await fixture.adapter.preflight()).readiness).toMatchObject({
      status: 'FAILED',
      canStart: false,
      diagnostics: [
        expect.objectContaining({ code: 'PROCESS_TERMINATION_UNCONFIRMED' })
      ]
    });

    process.stdout('late output from the unsafe process tree\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await fixture.store.readArtifact(run.outputArtifactId)).toBe(outputBeforeFailure);
    const retry = await createRun(fixture, fixture.session, 'CONTROLLED');
    await expect(
      fixture.adapter.startTurn(turnInput(retry, fixture.session, 'CONTROLLED'))
    ).rejects.toThrow('safety-fenced until Task Monki restarts');
    expect(process.startCount).toBe(1);
    await fixture.adapter.shutdown();
  });

  it('does not mark a natural exit interrupted when the durable interrupt transition fails', async () => {
    const fixture = await createFixture();
    const run = await createRun(fixture, fixture.session, 'SLOW_SUCCESS');
    const turn = await fixture.adapter.startTurn(
      turnInput(run, fixture.session, 'SLOW_SUCCESS')
    );
    const originalUpdateRun = fixture.store.updateRun.bind(fixture.store);
    vi.spyOn(fixture.store, 'updateRun').mockImplementation(async (runId, update) => {
      if (update.status === 'INTERRUPTING') {
        throw new Error('simulated interrupt persistence failure');
      }
      return originalUpdateRun(runId, update);
    });

    await expect(
      fixture.adapter.interruptTurn({
        session: { localSessionId: fixture.session.id },
        providerTurnId: turn.providerTurnId!
      })
    ).rejects.toThrow('simulated interrupt persistence failure');
    const completed = await waitForRun(fixture.store, run.id, ['COMPLETED']);
    expect(completed.terminalReason).toBeUndefined();
    await fixture.adapter.shutdown();
  });

  it('redacts split credentials before journals, artifacts, final state, or UI can observe them', async () => {
    const process = new ControlledProcessSupervisor();
    const exactSecret = 'opaque-exact-sensitive-value-12345';
    const shapedToken = 'sk-ant-abcdefghijklmnop';
    const uriUsername = 'provider-user';
    const uriPassword = 'provider-password';
    const fixture = await createFixture(true, {
      processSupervisor: process,
      environment: { PATH: processEnvPath(), HTTPS_PROXY: exactSecret }
    });
    const run = await createRun(fixture, fixture.session, 'CONTROLLED');
    const emittedOutput: string[] = [];
    const stopListening = fixture.events.on((event) => {
      if (event.type === 'run.output' && event.runId === run.id) {
        emittedOutput.push(
          String((event.payload as { text?: unknown }).text ?? '')
        );
      }
    });
    const journal = collectInboundJournal(fixture.store);
    await fixture.adapter.startTurn(turnInput(run, fixture.session, 'CONTROLLED'));

    process.stdout(`exact=${exactSecret.slice(0, 11)}`);
    process.stdout(`${exactSecret.slice(11)}\n`);
    process.stderr(`token=${shapedToken.slice(0, 10)}`);
    process.stderr(shapedToken.slice(10));
    process.stdout(`endpoint=https://${uriUsername}:${uriPassword.slice(0, 9)}`);
    process.stdout(`${uriPassword.slice(9)}@example.test/path\n`);
    emitInChunks(process, 'stdout', `${'z'.repeat(64 * 1024 + 1)}\nafter-oversized\n`, 8191);
    process.close(0, null);

    const completed = await waitForRun(fixture.store, run.id, ['COMPLETED']);
    stopListening();
    const outputArtifact = await fixture.store.readArtifact(run.outputArtifactId);
    const diagnosticArtifact = await fixture.store.readArtifact(run.diagnosticArtifactId);
    expect(completed.finalArtifactId).toBeDefined();
    const finalArtifact = await fixture.store.readArtifact(completed.finalArtifactId!);
    const journalText = journal.map((entry) => entry.raw).join('');
    const uiText = emittedOutput.join('');
    for (const retained of [
      completed.finalMessage ?? '',
      outputArtifact,
      diagnosticArtifact,
      finalArtifact,
      journalText,
      uiText
    ]) {
      expect(retained).not.toContain(exactSecret);
      expect(retained).not.toContain(shapedToken);
      expect(retained).not.toContain(exactSecret.slice(0, 11));
      expect(retained).not.toContain(shapedToken.slice(0, 10));
      expect(retained).not.toContain(uriUsername);
      expect(retained).not.toContain(uriPassword);
    }
    expect(outputArtifact).toContain('exact=[REDACTED]');
    expect(diagnosticArtifact).toContain('token=[REDACTED]');
    expect(outputArtifact).toContain(
      'endpoint=https://[REDACTED]@example.test/path'
    );
    expect(outputArtifact).toContain(
      '[Antigravity stdout line discarded at the 64 KiB safety limit.]'
    );
    expect(outputArtifact).toContain('after-oversized');
    expect(outputArtifact).not.toContain('z'.repeat(256));
    expect(
      countOccurrences(
        outputArtifact,
        '[Antigravity stdout line discarded at the 64 KiB safety limit.]'
      )
    ).toBe(1);
    await fixture.adapter.shutdown();
  });

  it('bounds each journal stream to its retention budget plus one truncation marker', async () => {
    const process = new ControlledProcessSupervisor();
    const fixture = await createFixture(true, { processSupervisor: process });
    const run = await createRun(fixture, fixture.session, 'CONTROLLED');
    const journal = collectInboundJournal(fixture.store);
    await fixture.adapter.startTurn(turnInput(run, fixture.session, 'CONTROLLED'));

    const safeLine = `${'v'.repeat(60 * 1024 - 1)}\n`;
    emitInChunks(process, 'stdout', safeLine.repeat(18), 17 * 1024 + 3);
    emitInChunks(process, 'stderr', safeLine.repeat(3), 13 * 1024 + 5);
    process.close(0, null);

    await waitForRun(fixture.store, run.id, ['COMPLETED'], 25_000);
    const outputArtifact = await fixture.store.readArtifact(run.outputArtifactId);
    const diagnosticArtifact = await fixture.store.readArtifact(run.diagnosticArtifactId);
    const stdoutMarker = '\n[Antigravity output truncated at 1 MiB.]\n';
    const stderrMarker = '\n[Antigravity diagnostics truncated at 128 KiB.]\n';
    const stdoutJournal = journal.filter((entry) => entry.stream === 'stdout');
    const stderrJournal = journal.filter((entry) => entry.stream === 'stderr');

    expect(countOccurrences(outputArtifact, stdoutMarker)).toBe(1);
    expect(countOccurrences(diagnosticArtifact, stderrMarker)).toBe(1);
    expect(stdoutJournal.filter((entry) => entry.raw === stdoutMarker)).toHaveLength(1);
    expect(stderrJournal.filter((entry) => entry.raw === stderrMarker)).toHaveLength(1);
    expect(Buffer.byteLength(outputArtifact)).toBeLessThanOrEqual(
      1024 * 1024 + Buffer.byteLength(stdoutMarker)
    );
    expect(Buffer.byteLength(diagnosticArtifact)).toBeLessThanOrEqual(
      128 * 1024 + Buffer.byteLength(stderrMarker)
    );
    expect(journalBytes(stdoutJournal)).toBeLessThanOrEqual(
      1024 * 1024 + Buffer.byteLength(stdoutMarker)
    );
    expect(journalBytes(stderrJournal)).toBeLessThanOrEqual(
      128 * 1024 + Buffer.byteLength(stderrMarker)
    );
    expect(journal.every((entry) => Buffer.byteLength(entry.raw) <= 64 * 1024)).toBe(true);
    await fixture.adapter.shutdown();
  }, 30_000);

  it('releases unrelated tasks while correctly fencing the task that owns an active turn', async () => {
    const fixture = await createFixture();
    const run = await createRun(fixture, fixture.session, 'WAIT');
    const turn = await fixture.adapter.startTurn(turnInput(run, fixture.session, 'WAIT'));

    await expect(fixture.adapter.releaseTask('another-task')).resolves.toBeUndefined();
    await expect(fixture.adapter.releaseTask(fixture.task.id)).rejects.toThrow(
      'while Antigravity is running'
    );
    await fixture.adapter.interruptTurn({
      session: { localSessionId: fixture.session.id },
      providerTurnId: turn.providerTurnId!
    });
    await fixture.adapter.shutdown();
  });

  it('does not resurrect a run terminalized after reconciliation snapshots it', async () => {
    const fixture = await createFixture();
    const run = await createRun(fixture, fixture.session, 'STALE SNAPSHOT');
    const snapshot = fixture.store.snapshot.bind(fixture.store);
    let terminalPublished = false;
    vi.spyOn(fixture.store, 'snapshot').mockImplementation(async () => {
      const stale = await snapshot();
      if (!terminalPublished) {
        terminalPublished = true;
        await fixture.store.appendEvent(
          createDomainEvent({
            type: 'AGENT_RUN_COMPLETED',
            taskId: run.taskId,
            iterationId: run.iterationId,
            runId: run.id,
            worktreeId: run.worktreeId,
            agentSessionId: run.sessionId,
            serverInstanceId: run.serverInstanceId,
            source: 'provider',
            payload: { terminalStatus: 'completed' }
          })
        );
      }
      return stale;
    });
    const updateAgentSession = vi.spyOn(fixture.store, 'updateAgentSession');

    const result = await fixture.adapter.reconcile();
    const current = await fixture.store.getRun(run.id);
    const events = (await snapshot()).events.filter((event) => event.runId === run.id);

    expect(current?.status).toBe('COMPLETED');
    expect(
      events.filter((event) =>
        ['AGENT_RUNTIME_LOST', 'AGENT_RUNTIME_RECONCILED'].includes(event.type)
      )
    ).toHaveLength(0);
    expect(updateAgentSession).not.toHaveBeenCalled();
    expect(result).toEqual({ reconciledSessionIds: [], recoveryRequiredSessionIds: [] });
    await fixture.adapter.shutdown();
  });

  it('fails closed into recoverable state if terminal persistence fails and releases session ownership', async () => {
    const fixture = await createFixture();
    const originalUpdateRun = fixture.store.updateRun.bind(fixture.store);
    const originalAppendRunEventIfStatus =
      fixture.store.appendRunEventIfStatus.bind(fixture.store);
    let failedOnce = false;
    let continueCleanup!: () => void;
    let markRecoveryPublished!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      continueCleanup = resolve;
    });
    const recoveryPublished = new Promise<void>((resolve) => {
      markRecoveryPublished = resolve;
    });
    vi.spyOn(fixture.store, 'updateRun').mockImplementation(async (runId, update) => {
      if (!failedOnce && update.finalMessage !== undefined) {
        failedOnce = true;
        throw new Error('simulated terminal persistence failure');
      }
      return originalUpdateRun(runId, update);
    });
    vi.spyOn(fixture.store, 'appendRunEventIfStatus').mockImplementation(
      async (event, statuses) => {
        const stored = await originalAppendRunEventIfStatus(event, statuses);
        if (event.type === 'AGENT_RUNTIME_RECONCILED') {
          markRecoveryPublished();
          await cleanupGate;
        }
        return stored;
      }
    );
    const run = await createRun(fixture, fixture.session, 'SUCCESS');
    await fixture.adapter.startTurn(turnInput(run, fixture.session, 'SUCCESS'));
    const recovery = await waitForRecovery(fixture.store, run.id);
    await recoveryPublished;

    expect(recovery.recoveryState).toBe('REQUIRES_USER_ACTION');
    expect((await fixture.store.getAgentSession(fixture.session.id))?.status).toBe('ACTIVE');
    const release = fixture.adapter.releaseSession({ localSessionId: fixture.session.id });
    let releaseSettled = false;
    void release.then(
      () => { releaseSettled = true; },
      () => { releaseSettled = true; }
    );
    await Promise.resolve();
    expect(releaseSettled).toBe(false);
    continueCleanup();
    await expect(release).resolves.toBeUndefined();
    expect((await fixture.store.getAgentSession(fixture.session.id))?.status).toBe('IDLE');
    await fixture.adapter.shutdown();
  });

  it('retains ownership and fences new starts when recovery publication persistently fails', async () => {
    const process = new ControlledProcessSupervisor();
    const fixture = await createFixture(true, { processSupervisor: process });
    const originalUpdateRun = fixture.store.updateRun.bind(fixture.store);
    const originalAppendRunEventIfStatus =
      fixture.store.appendRunEventIfStatus.bind(fixture.store);
    let terminalPersistenceFailed = false;
    const updateRun = vi.spyOn(fixture.store, 'updateRun').mockImplementation(
      async (runId, update) => {
        if (!terminalPersistenceFailed && update.finalMessage !== undefined) {
          terminalPersistenceFailed = true;
          throw new Error('simulated terminal persistence failure');
        }
        return originalUpdateRun(runId, update);
      }
    );
    const appendEvent = vi.spyOn(fixture.store, 'appendRunEventIfStatus').mockImplementation(
      async (event, statuses) => {
        if (event.type === 'AGENT_RUNTIME_RECONCILED') {
          throw new Error('persistent recovery publication failure');
        }
        return originalAppendRunEventIfStatus(event, statuses);
      }
    );
    const run = await createRun(fixture, fixture.session, 'CONTROLLED');
    await fixture.adapter.startTurn(
      turnInput(run, fixture.session, 'CONTROLLED')
    );

    process.stdout('provider work completed\n');
    process.close(0, null);

    const stranded = await waitForRun(
      fixture.store,
      run.id,
      ['RECOVERY_REQUIRED']
    );
    expect(stranded.recoveryState).toBe('RECONCILING');
    expect((await waitForReadiness(fixture.adapter, 'FAILED')).readiness).toMatchObject({
      canStart: false,
      diagnostics: [
        expect.objectContaining({ code: 'RECOVERY_PUBLICATION_FAILED' })
      ]
    });
    await expect(
      fixture.adapter.releaseSession({ localSessionId: fixture.session.id })
    ).rejects.toThrow(`run ${run.id} is active`);

    const retry = await createRun(fixture, fixture.session, 'CONTROLLED');
    await expect(
      fixture.adapter.startTurn(turnInput(retry, fixture.session, 'CONTROLLED'))
    ).rejects.toThrow('recovery state could not be persisted');
    expect(process.startCount).toBe(1);
    await expect(fixture.adapter.shutdown()).rejects.toThrow(
      'Antigravity runtime shutdown was incomplete'
    );
    expect(process.cancel).not.toHaveBeenCalled();

    updateRun.mockRestore();
    appendEvent.mockRestore();
    const restarted = new AntigravityAdapter(fixture.store, fixture.events, {
      cwd: fixture.root,
      executable: fixture.executable,
      runtimeResolver: async () => resolvedRuntime(fixture.executable)
    });
    await restarted.initialize();
    const recovered = await waitForRecovery(fixture.store, run.id);
    expect(recovered.recoveryState).toBe('REQUIRES_USER_ACTION');
    expect(process.startCount).toBe(1);
    await restarted.shutdown();
  });

  it('runs through orchestration with an explicitly local-only session identity', async () => {
    const fixture = await createFixture(false);
    const registry = new AgentRuntimeRegistry([fixture.adapter], 'antigravity');
    const orchestrator = new AgentOrchestrator(fixture.store, fixture.events, registry);
    await orchestrator.initialize(['antigravity']);

    const run = await orchestrator.startTurn({
      task: fixture.task,
      iteration: fixture.iteration,
      worktree: fixture.worktree,
      mode: 'IMPLEMENTATION',
      prompt: 'SUCCESS',
      settings: SETTINGS
    });
    await waitForRun(fixture.store, run.id, ['COMPLETED']);
    const session = await fixture.store.getPrimaryAgentSession(
      fixture.task.id,
      fixture.iteration.id
    );
    expect(session?.materialized).toBe(true);
    expect(session?.providerSessionId).toBeUndefined();
    await orchestrator.shutdown();
  });

  it('rejects startup and releases ownership when initial process persistence fails', async () => {
    const fixture = await createFixture();
    const originalUpdateServer = fixture.store.updateAgentServer.bind(fixture.store);
    let failedOnce = false;
    vi.spyOn(fixture.store, 'updateAgentServer').mockImplementation(
      async (serverId, update) => {
        if (!failedOnce && update.status === 'RUNNING') {
          failedOnce = true;
          throw new Error('simulated startup persistence failure');
        }
        return originalUpdateServer(serverId, update);
      }
    );
    const run = await createRun(fixture, fixture.session, 'WAIT');

    await expect(
      fixture.adapter.startTurn(turnInput(run, fixture.session, 'WAIT'))
    ).rejects.toThrow('simulated startup persistence failure');
    await waitForRecovery(fixture.store, run.id);
    expect(await waitForSessionStatus(fixture.store, fixture.session.id, 'IDLE')).toBe(
      'IDLE'
    );
    await expect(
      fixture.adapter.releaseSession({ localSessionId: fixture.session.id })
    ).resolves.toBeUndefined();
    await fixture.adapter.shutdown();
  });

  it.each(['outbound journal', 'process start'] as const)(
    'terminalizes the server when %s fails before process ownership',
    async (boundary) => {
      const process = boundary === 'process start'
        ? new FailingStartProcessSupervisor()
        : new ControlledProcessSupervisor();
      const fixture = await createFixture(true, { processSupervisor: process });
      if (boundary === 'outbound journal') {
        vi.spyOn(fixture.store, 'appendProtocolMessage').mockRejectedValueOnce(
          new Error('simulated outbound journal failure')
        );
      }
      const run = await createRun(fixture, fixture.session, 'WAIT');

      await expect(
        fixture.adapter.startTurn(turnInput(run, fixture.session, 'WAIT'))
      ).rejects.toThrow(
        boundary === 'process start'
          ? 'simulated process start failure'
          : 'simulated outbound journal failure'
      );

      const storedRun = await fixture.store.getRun(run.id);
      const server = (await fixture.store.snapshot()).agentServers.find(
        (candidate) => candidate.id === storedRun?.serverInstanceId
      );
      expect(server).toMatchObject({
        status: 'FAILED',
        exitReason:
          boundary === 'process start'
            ? 'simulated process start failure'
            : 'simulated outbound journal failure'
      });
      expect(server?.exitedAt).toBeTruthy();
      expect(process.startCount).toBe(boundary === 'process start' ? 1 : 0);
      await expect(
        fixture.adapter.releaseSession({ localSessionId: fixture.session.id })
      ).resolves.toBeUndefined();
      await fixture.adapter.shutdown();
    }
  );
});

interface Fixture {
  root: string;
  executable: string;
  store: FileTaskStore;
  events: AppEventBus;
  adapter: AntigravityAdapter;
  task: Awaited<ReturnType<FileTaskStore['createTask']>>;
  iteration: Awaited<ReturnType<FileTaskStore['createIterationAndWorktree']>>['iteration'];
  worktree: Awaited<ReturnType<FileTaskStore['createIterationAndWorktree']>>['worktree'];
  session: AgentSessionRecord;
}

interface FixtureOptions {
  environment?: NodeJS.ProcessEnv;
  processSupervisor?: ProcessSupervisor;
}

async function createFixture(
  materialize = true,
  options: FixtureOptions = {}
): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-antigravity-'));
  directories.push(root);
  const appCwd = path.join(root, 'app');
  const worktreePath = path.join(root, 'worktree');
  await fs.mkdir(appCwd, { recursive: true });
  await fs.mkdir(worktreePath, { recursive: true });
  const executable = await writeNodeExecutable(root, 'agy', fakeAgyScript());
  const runtime = resolvedRuntime(executable);
  const store = new FileTaskStore(path.join(root, 'store'));
  const events = new AppEventBus();
  const adapter = new AntigravityAdapter(store, events, {
    cwd: appCwd,
    executable,
    runtimeResolver: async () => runtime,
    environment: options.environment,
    processSupervisor: options.processSupervisor
  });
  const task = await store.createTask({
    runtimeId: 'antigravity',
    title: 'Antigravity adapter',
    prompt: 'Exercise the documented CLI.',
    repositoryPath: worktreePath,
    agentSettings: SETTINGS
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: 'codex/antigravity-adapter',
    worktreePath,
    baseSha: 'base-sha'
  });
  await adapter.initialize();
  let session = await store.createAgentSession({
    task,
    iteration,
    worktree,
    runtimeId: 'antigravity',
    requestedSettings: SETTINGS
  });
  if (materialize) {
    session = await adapter.createSession({
      runtimeId: 'antigravity',
      localSessionId: session.id,
      taskId: task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      worktreePath,
      settings: SETTINGS
    });
  }
  return { root, executable, store, events, adapter, task, iteration, worktree, session };
}

function resolvedRuntime(executable: string): ResolvedAntigravityRuntime {
  return {
    executable,
    source: 'config',
    diagnostics: {
      selectedExecutable: executable,
      selectedSource: 'config',
      selectedLaunchArgv: ['--print', '<prompt>'],
      requiredCapabilities: ['agy models', '--new-project', '--sandbox'],
      probes: []
    }
  };
}

class ControlledProcessSupervisor extends ProcessSupervisor {
  private readonly controlledEvents = new EventEmitter() as SupervisedProcess['events'];
  private closed = false;
  private terminationFailure?: Error;
  startCount = 0;
  readonly cancel = vi.fn(async () => {
    if (this.terminationFailure) throw this.terminationFailure;
    this.close(null, 'SIGINT');
  });

  override start(_spec: ProcessSpec): SupervisedProcess {
    this.startCount += 1;
    queueMicrotask(() => {
      this.controlledEvents.emit('started', { pid: 4242 });
    });
    return {
      pid: 4242,
      events: this.controlledEvents,
      cancel: this.cancel
    };
  }

  stdout(value: string): void {
    this.controlledEvents.emit('stdout', Buffer.from(value));
  }

  stderr(value: string): void {
    this.controlledEvents.emit('stderr', Buffer.from(value));
  }

  terminationUnconfirmed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.terminationFailure = error;
    this.controlledEvents.emit('terminationUnconfirmed', {
      error,
      leaderExit: { exitCode: 0, signal: null }
    });
  }

  close(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.controlledEvents.emit('close', { exitCode, signal });
  }
}

class FailingStartProcessSupervisor extends ProcessSupervisor {
  startCount = 0;

  override start(_spec: ProcessSpec): SupervisedProcess {
    this.startCount += 1;
    throw new Error('simulated process start failure');
  }
}

function blockNextInboundJournal(
  store: FileTaskStore,
  stream: 'stdout' | 'stderr'
): { entered: Promise<void>; release(): void } {
  const original = store.appendProtocolMessage.bind(store);
  let release!: () => void;
  let markEntered!: () => void;
  let blocked = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  vi.spyOn(store, 'appendProtocolMessage').mockImplementation(
    async (serverInstanceId, direction, raw, metadata) => {
      if (!blocked && direction === 'INBOUND' && metadata?.stream === stream) {
        blocked = true;
        markEntered();
        await gate;
      }
      return original(serverInstanceId, direction, raw, metadata);
    }
  );
  return { entered, release };
}

function blockNextInterruptPersistence(
  store: FileTaskStore
): { entered: Promise<void>; release(): void } {
  const original = store.updateRun.bind(store);
  let release!: () => void;
  let markEntered!: () => void;
  let blocked = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  vi.spyOn(store, 'updateRun').mockImplementation(async (runId, update) => {
    if (!blocked && update.status === 'INTERRUPTING') {
      blocked = true;
      markEntered();
      await gate;
    }
    return original(runId, update);
  });
  return { entered, release };
}

function observeNextProviderTurnLookup(store: FileTaskStore): Promise<void> {
  const original = store.getRunByProviderTurnId.bind(store);
  let observed!: () => void;
  const result = new Promise<void>((resolve) => {
    observed = resolve;
  });
  vi.spyOn(store, 'getRunByProviderTurnId').mockImplementation(
    async (runtimeId, providerTurnId) => {
      const run = await original(runtimeId, providerTurnId);
      observed();
      return run;
    }
  );
  return result;
}

interface CollectedJournalEntry {
  raw: string;
  stream: 'stdout' | 'stderr';
}

function collectInboundJournal(store: FileTaskStore): CollectedJournalEntry[] {
  const collected: CollectedJournalEntry[] = [];
  const original = store.appendProtocolMessage.bind(store);
  vi.spyOn(store, 'appendProtocolMessage').mockImplementation(
    async (serverInstanceId, direction, raw, metadata) => {
      if (
        direction === 'INBOUND' &&
        (metadata?.stream === 'stdout' || metadata?.stream === 'stderr')
      ) {
        collected.push({ raw, stream: metadata.stream });
      }
      return original(serverInstanceId, direction, raw, metadata);
    }
  );
  return collected;
}

function emitInChunks(
  process: ControlledProcessSupervisor,
  stream: 'stdout' | 'stderr',
  value: string,
  chunkSize: number
): void {
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    process[stream](value.slice(offset, offset + chunkSize));
  }
}

function journalBytes(entries: readonly CollectedJournalEntry[]): number {
  return entries.reduce((total, entry) => total + Buffer.byteLength(entry.raw), 0);
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

function processEnvPath(): string | undefined {
  return process.env.PATH;
}

async function createRun(
  fixture: Fixture,
  session: AgentSessionRecord,
  prompt: string,
  mode: RunRecord['mode'] = 'IMPLEMENTATION'
): Promise<RunRecord> {
  return fixture.store.createRun({
    task: fixture.task,
    session,
    mode,
    prompt,
    requestedSettings: SETTINGS
  });
}

function turnInput(
  run: RunRecord,
  session: AgentSessionRecord,
  prompt: string,
  mode: RunRecord['mode'] = 'IMPLEMENTATION'
) {
  return {
    localRunId: run.id,
    session: { localSessionId: session.id },
    mode,
    prompt,
    authoritativeGoal: prompt,
    settings: SETTINGS
  } as const;
}

async function waitForRun(
  store: FileTaskStore,
  runId: string,
  statuses: readonly RunRecord['status'][],
  timeoutMs = 5_000
): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run && statuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach ${statuses.join(', ')}.`);
}

async function waitForRecovery(
  store: FileTaskStore,
  runId: string
): Promise<RunRecord> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (
      run?.status === 'RECOVERY_REQUIRED' &&
      run.recoveryState === 'REQUIRES_USER_ACTION'
    ) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for run ${runId} recovery ownership release.`);
}

async function waitForSessionStatus(
  store: FileTaskStore,
  sessionId: string,
  status: AgentSessionRecord['status']
): Promise<AgentSessionRecord['status']> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const session = await store.getAgentSession(sessionId);
    if (session?.status === status) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for session ${sessionId} to become ${status}.`);
}

async function waitForFileLineCount(filePath: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const lines = (await fs.readFile(filePath, 'utf8')).trim().split('\n');
      if (lines.length >= count) return;
    } catch {
      // The discovery child has not created the observation file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} lines in ${filePath}.`);
}

async function waitForReadiness(
  adapter: AntigravityAdapter,
  status: Awaited<ReturnType<AntigravityAdapter['preflight']>>['readiness']['status']
): Promise<Awaited<ReturnType<AntigravityAdapter['preflight']>>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const preflight = await adapter.preflight();
    if (preflight.readiness.status === status) return preflight;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for Antigravity readiness ${status}.`);
}

function fakeAgyScript(): string {
  const catalog = [
    'Gemini 3.5 Flash (Low)',
    'Claude Sonnet 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)'
  ].join('\n');
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const expectedXpcServiceName = ${JSON.stringify(ANTIGRAVITY_MACOS_XPC_SERVICE_NAME)};`,
    "if (process.env.CODEX_HOME !== undefined) process.exit(12);",
    "if (process.platform === 'darwin' && process.env.XPC_SERVICE_NAME !== expectedXpcServiceName) process.exit(13);",
    "if (process.platform !== 'darwin' && process.env.XPC_SERVICE_NAME !== undefined) process.exit(14);",
    'const argv = process.argv.slice(2);',
    `if (argv.length === 1 && argv[0] === 'models') { process.stdout.write(${JSON.stringify(`${catalog}\n`)}); process.exit(0); }`,
    "const promptIndex = argv.indexOf('--print');",
    "if (promptIndex < 0) process.exit(9);",
    'const prompt = argv[promptIndex + 1];',
    "fs.writeFileSync(path.join(process.cwd(), '.fake-agy-argv.json'), JSON.stringify(argv));",
    "fs.writeFileSync(path.join(process.cwd(), '.fake-agy-env.json'), JSON.stringify({ xpcServiceName: process.env.XPC_SERVICE_NAME, codexHome: process.env.CODEX_HOME }));",
    "if (prompt === 'WAIT') { setInterval(() => undefined, 1000); }",
    "else if (prompt === 'FAIL') { process.stderr.write('simulated provider failure'); process.exit(7); }",
    "else { setTimeout(() => { process.stdout.write('Antigravity completed ' + prompt); }, prompt === 'SLOW_SUCCESS' ? 250 : 30); }"
  ].join('\n');
}
