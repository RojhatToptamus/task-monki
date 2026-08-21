import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexLabTextDriver,
  assertCodexLabIsolation,
  attestCodexLabThreadFork,
  attestCodexLabThreadStart
} from './CodexTextDriver';
import { resolveCodexAppServerArgv } from '../../core/agent/codex/CodexAppServerSupervisor';
import type { LabTextCallInput } from './textDriver';

describe('Codex Lab v2 boundary attestation', () => {
  it('attests the exact zero-context thread/start response', () => {
    const cwd = '/tmp/discourse-lab-empty';
    const response = threadStartResponse({ cwd, serviceTier: 'priority' });

    expect(
      attestCodexLabThreadStart(response as never, {
        cwd,
        profileId: 'lab-profile',
        model: 'fake-model',
        reasoningEffort: 'medium',
        serviceTier: 'priority'
      })
    ).toEqual({
      model: 'fake-model',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      serviceTier: 'priority',
      instructionSources: []
    });
  });

  it('accepts no runtime root after an explicit empty environments request', () => {
    const cwd = '/tmp/discourse-lab-empty';
    const response = threadStartResponse({
      cwd,
      serviceTier: 'priority',
      runtimeWorkspaceRoots: []
    });

    expect(
      attestCodexLabThreadStart(response as never, {
        cwd,
        profileId: 'lab-profile',
        model: 'fake-model',
        reasoningEffort: 'medium',
        serviceTier: 'priority'
      })
    ).toEqual(expect.objectContaining({ model: 'fake-model', instructionSources: [] }));
  });

  it('rejects any runtime root outside the verified empty cwd', () => {
    const cwd = '/tmp/discourse-lab-empty';
    const response = threadStartResponse({
      cwd,
      serviceTier: 'priority',
      runtimeWorkspaceRoots: ['/tmp/unsealed-context']
    });

    expect(() =>
      attestCodexLabThreadStart(response as never, {
        cwd,
        profileId: 'lab-profile',
        model: 'fake-model',
        reasoningEffort: 'medium',
        serviceTier: 'priority'
      })
    ).toThrowError(expect.objectContaining({ mismatchFields: ['runtimeWorkspaceRoots'] }));
  });

  it('reports inherited instructions and null-to-default tier normalization by field', () => {
    const cwd = '/tmp/discourse-lab-empty';
    const response = threadStartResponse({
      cwd,
      serviceTier: 'default',
      instructionSources: ['/isolated/AGENTS.md', '/repository/AGENTS.md']
    });

    expect(() =>
      attestCodexLabThreadStart(response as never, {
        cwd,
        profileId: 'lab-profile',
        model: 'fake-model',
        reasoningEffort: 'medium'
      })
    ).toThrowError(
      expect.objectContaining({
        mismatchFields: ['serviceTier', 'instructionSources'],
        observed: expect.objectContaining({
          serviceTier: 'default',
          instructionSources: ['/isolated/AGENTS.md', '/repository/AGENTS.md']
        })
      })
    );
  });

  it('attests exact fork ancestry and inherited provider turns', () => {
    const cwd = '/tmp/discourse-lab-empty';
    const sourceSession = {
      driverId: 'codex-app-server-harness-isolated-v6',
      providerThreadId: 'thread-source',
      providerSessionTreeId: 'session-tree-1'
    };
    const response = threadForkResponse({
      cwd,
      sourceSession,
      inheritedProviderTurnIds: ['turn-1']
    });

    expect(attestCodexLabThreadFork(response as never, {
      cwd,
      profileId: 'lab-profile',
      model: 'fake-model',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      serviceTier: 'priority',
      sourceSession,
      inheritedProviderTurnIds: ['turn-1']
    })).toMatchObject({
      session: {
        providerThreadId: 'thread-fork',
        providerSessionTreeId: 'session-tree-1'
      },
      inheritedProviderTurnIds: ['turn-1']
    });
  });

  it('rejects a fork that does not contain the exact source checkpoint', () => {
    const cwd = '/tmp/discourse-lab-empty';
    const sourceSession = {
      driverId: 'codex-app-server-harness-isolated-v6',
      providerThreadId: 'thread-source',
      providerSessionTreeId: 'session-tree-1'
    };
    const response = threadForkResponse({
      cwd,
      sourceSession,
      inheritedProviderTurnIds: ['different-turn']
    });

    expect(() => attestCodexLabThreadFork(response as never, {
      cwd,
      profileId: 'lab-profile',
      model: 'fake-model',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      serviceTier: 'priority',
      sourceSession,
      inheritedProviderTurnIds: ['turn-1']
    })).toThrowError(expect.objectContaining({
      mismatchFields: ['inheritedProviderTurnIds']
    }));
  });

  it('rejects user-home instructions, plugin/MCP configuration, and repository cwd roots', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-lab-isolation-'))
    );
    const repositoryRoot = path.join(root, 'repository');
    const codexHome = path.join(root, 'codex-home');
    const executionRoot = path.join(root, 'execution');
    await Promise.all([
      fs.mkdir(repositoryRoot),
      fs.mkdir(codexHome),
      fs.mkdir(executionRoot)
    ]);

    await expect(
      assertCodexLabIsolation({ codexHome, executionRoot, repositoryRoot })
    ).resolves.toBeUndefined();

    await fs.writeFile(path.join(codexHome, 'AGENTS.md'), 'inherited instructions');
    await expect(
      assertCodexLabIsolation({ codexHome, executionRoot, repositoryRoot })
    ).rejects.toThrow('global AGENTS');
    await fs.unlink(path.join(codexHome, 'AGENTS.md'));

    await fs.writeFile(path.join(codexHome, 'config.toml'), '[mcp_servers.example]\nurl="x"\n');
    await expect(
      assertCodexLabIsolation({ codexHome, executionRoot, repositoryRoot })
    ).rejects.toThrow('plugin or MCP configuration');

    const repositoryExecution = path.join(repositoryRoot, 'execution');
    await fs.mkdir(repositoryExecution);
    await expect(
      assertCodexLabIsolation({
        codexHome,
        executionRoot: repositoryExecution,
        repositoryRoot
      })
    ).rejects.toThrow('outside the Task Monki repository');
  });

  it.each(['instructions', 'mcp'] as const)(
    'rejects a %s boundary probe and never submits turn/start',
    async (mode) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-lab-${mode}-`))
      );
      const codexHome = path.join(root, 'codex-home');
      const executionRoot = path.join(root, 'execution');
      const stateRoot = path.join(root, 'state');
      const fakeServer = path.join(root, 'fake-server.cjs');
      const turnMarker = path.join(root, 'turn-started');
      await Promise.all([fs.mkdir(codexHome), fs.mkdir(executionRoot)]);
      await fs.writeFile(fakeServer, fakeAppServer(mode, turnMarker), { mode: 0o700 });

      const driver = new CodexLabTextDriver({
        stateRoot,
        executionRoot,
        codexHome,
        repositoryRoot: process.cwd(),
        appVersion: 'test',
        executable: process.execPath,
        runtimeResolver: async () => ({
          executable: process.execPath,
          source: 'config',
          version: '0.144.6',
          compatibility: {
            launch: { argv: [fakeServer], transport: 'STDIO', form: 'stdio-flag' },
            requiredMethods: []
          },
          diagnostics: []
        }),
        argvResolver: async () => [fakeServer]
      });

      try {
        const preflight = await driver.preflight({
          model: 'fake-model',
          reasoningEffort: 'medium',
          serviceTier: 'priority'
        });
        expect(preflight.ready).toBe(false);
        expect(preflight.boundary.status).toBe('REJECTED');
        expect(preflight.boundary.mismatchFields).toContain(
          mode === 'instructions' ? 'instructionSources' : 'mcpStartupEvents'
        );

        const call = await driver.call({
          callKey: 'must-not-run',
          prompt: 'ordinary text',
          outputSchema: { type: 'object' },
          model: 'fake-model',
          reasoningEffort: 'medium',
          serviceTier: 'priority',
          maximumOutputTokens: 100,
          maximumCallMs: 1_000,
          experimentDeadlineMs: Date.now() + 1_000
        });
        expect(call.failure?.kind).toBe(
          mode === 'mcp' ? 'TOOL_CONTEXT_VIOLATION' : 'SETTINGS_MISMATCH'
        );
        expect(call.providerAccounting).toEqual({
          sessionAttestation: 'NOT_PRESENT',
          threadStartStatus: 'NOT_STARTED',
          providerTurnStarted: 'NO',
          billableModelCall: 'NO'
        });
        await expect(fs.access(turnMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (mode === 'mcp') {
          await expect(driver.close()).rejects.toThrow('forbidden boundary events');
        } else {
          await driver.close();
        }
      }
    }
  );
});

describe('Codex Lab v3 semantic call boundary', () => {
  it('launches with the exact lab-only MCP disable override', async () => {
    const fixture = await semanticFixture('missing-usage');
    try {
      expect(fixture.launchArgv).toEqual([[
        fixture.fakeServer,
        '-c',
        'features.apps=false',
        '-c',
        'web_search="disabled"',
        '-c',
        'features.plugins=false',
        '-c',
        'features.remote_plugin=false',
        '-c',
        'plugins.openai-developers.mcp_servers.openai-api-key-local-confirmation.enabled=false'
      ]]);
    } finally {
      await fixture.driver.close();
    }
  });

  it('captures provider usage that follows normal completion and sends the sealed thread boundary', async () => {
    const fixture = await semanticFixture('late-usage');
    try {
      const result = await fixture.driver.call(semanticCallInput());

      expect(result.failure).toBeUndefined();
      expect(result.rawText).toBe('{"ok":true}');
      expect(result.tokenControl).toEqual({
        targetOutputTokens: 900,
        safetyCeilingOutputTokens: 25_000,
        providerEnforcedLimit: false,
        usageStatus: 'PROVIDER_REPORTED',
        observedOutputTokens: 840,
        targetOvershootTokens: 0,
        safetyOvershootTokens: 0
      });
      const terminalIndex = result.lifecycle.findIndex((entry) => entry.event === 'terminal');
      const usageIndex = result.lifecycle.findIndex(
        (entry) => entry.event === 'provider-usage-observed'
      );
      expect(terminalIndex).toBeGreaterThanOrEqual(0);
      expect(usageIndex).toBeGreaterThan(terminalIndex);

      const starts = await readCapturedThreadStarts(fixture.capturePath);
      expect(starts).toHaveLength(2);
      for (const params of starts) {
        expect(params.environments).toEqual([]);
        expect(params.dynamicTools).toEqual([]);
        expect(params.selectedCapabilityRoots).toEqual([]);
        expect(params.config).toMatchObject({
          project_doc_max_bytes: 0,
          features: {
            apps: false,
            goals: false,
            hooks: false,
            memories: false,
            multi_agent: false,
            multi_agent_v2: false,
            remote_plugin: false,
            shell_tool: false,
            skill_mcp_dependency_install: false,
            unified_exec: false
          }
        });
        expect(params.config).not.toHaveProperty('agents');
      }
    } finally {
      await fixture.driver.close();
    }
  });

  it('forks an exact completed checkpoint and continues only the child thread', async () => {
    const fixture = await semanticFixture('late-usage');
    try {
      const source = await fixture.driver.call(semanticCallInput({ callKey: 'source' }));
      expect(source.failure).toBeUndefined();
      expect(source.session).toBeDefined();
      expect(source.providerTurnId).toBeDefined();

      const fork = await fixture.driver.fork({
        forkKey: 'fork-1',
        sourceSession: source.session!,
        model: 'fake-model',
        reasoningEffort: 'medium',
        serviceTier: 'priority',
        maximumForkMs: 2_000,
        experimentDeadlineMs: Date.now() + 5_000
      });

      expect(fork.failure).toBeUndefined();
      expect(fork.inheritedProviderTurnIds).toEqual([source.providerTurnId]);
      expect(fork.session).toMatchObject({
        providerSessionTreeId: source.session!.providerSessionTreeId
      });
      expect(fork.session!.providerThreadId).not.toBe(source.session!.providerThreadId);
      expect(fork.providerAccounting).toEqual({
        forkMutationSubmitted: 'YES',
        forkMutationAcknowledged: 'YES',
        providerTurnStarted: 'NO',
        billableModelCall: 'NO'
      });

      const child = await fixture.driver.call(semanticCallInput({
        callKey: 'child',
        continuation: fork.session
      }));
      expect(child.failure).toBeUndefined();
      expect(child.session).toEqual(fork.session);
      expect(child.providerAccounting.threadStartStatus).toBe('NOT_REQUIRED');
    } finally {
      await fixture.driver.close();
    }
  });

  it('fences an ambiguously delivered fork without starting a model turn', async () => {
    const fixture = await semanticFixture('fork-timeout');
    try {
      const source = await fixture.driver.call(semanticCallInput({ callKey: 'source' }));
      const fork = await fixture.driver.fork({
        forkKey: 'ambiguous-fork',
        sourceSession: source.session!,
        model: 'fake-model',
        reasoningEffort: 'medium',
        serviceTier: 'priority',
        maximumForkMs: 100,
        experimentDeadlineMs: Date.now() + 1_000
      });

      expect(fork.failure?.kind).toBe('AMBIGUOUS_DELIVERY');
      expect(fork.providerAccounting).toEqual({
        forkMutationSubmitted: 'YES',
        forkMutationAcknowledged: 'UNKNOWN',
        providerTurnStarted: 'NO',
        billableModelCall: 'NO'
      });
    } finally {
      await fixture.driver.close();
    }
  });

  it('captures provider usage that follows a timeout interrupt terminal', async () => {
    const fixture = await semanticFixture('timeout-late-usage');
    try {
      const result = await fixture.driver.call(semanticCallInput({ maximumCallMs: 200 }));

      expect(result.failure?.kind).toBe('TIMEOUT');
      expect(result.rawText).toBe('{"ok":true}');
      expect(result.providerStatus).toBe('interrupted');
      expect(result.tokenControl?.usageStatus).toBe('PROVIDER_REPORTED');
      expect(result.tokenControl?.observedOutputTokens).toBe(840);
      expect(result.lifecycle.map((entry) => entry.event)).toEqual(
        expect.arrayContaining([
          'interrupt-submitted',
          'interrupt-acknowledged',
          'terminal',
          'provider-usage-observed'
        ])
      );
    } finally {
      await fixture.driver.close();
    }
  });

  it('records bounded missing provider usage explicitly', async () => {
    const fixture = await semanticFixture('missing-usage');
    try {
      const result = await fixture.driver.call(semanticCallInput());

      expect(result.failure).toBeUndefined();
      expect(result.rawText).toBe('{"ok":true}');
      expect(result.usage).toBeUndefined();
      expect(result.tokenControl).toMatchObject({
        usageStatus: 'UNAVAILABLE',
        observedOutputTokens: null,
        targetOvershootTokens: null,
        safetyOvershootTokens: null
      });
      expect(result.lifecycle).toContainEqual(
        expect.objectContaining({
          event: 'provider-usage-unavailable',
          detail: expect.objectContaining({ terminalObserved: true })
        })
      );
    } finally {
      await fixture.driver.close();
    }
  });

  it('releases the losing call-deadline timer after normal terminal completion', async () => {
    const fixture = await semanticFixture('missing-usage');
    try {
      const timeoutCountBefore = activeTimeoutCount();

      await fixture.driver.call(semanticCallInput());

      expect(activeTimeoutCount()).toBe(timeoutCountBefore);
    } finally {
      await fixture.driver.close();
    }
  });

  it('reuses one authoritative close operation across concurrent lifecycle owners', async () => {
    const fixture = await semanticFixture('missing-usage');

    const firstClose = fixture.driver.close();
    const secondClose = fixture.driver.close();

    expect(secondClose).toBe(firstClose);
    await firstClose;
    await expect(fixture.driver.close()).resolves.toBeUndefined();
  });

  it('releases the losing terminal-grace timer after an interrupted turn terminates', async () => {
    const fixture = await semanticFixture('timeout-late-usage');
    try {
      const timeoutCountBefore = activeTimeoutCount();

      await fixture.driver.call(semanticCallInput({ maximumCallMs: 200 }));
      // Provider usage wins its separate 500 ms grace race in this fixture.
      // Let that unrelated losing delay expire before checking the 5 s
      // waitForTerminal deadline.
      await new Promise((resolve) => setTimeout(resolve, 550));

      expect(activeTimeoutCount()).toBe(timeoutCountBefore);
    } finally {
      await fixture.driver.close();
    }
  });

  it('uses one absolute call deadline across delayed thread setup and generation', async () => {
    const fixture = await semanticFixture('delayed-thread-start-timeout');
    try {
      const maximumCallMs = 500;
      const startedMs = Date.now();
      const result = await fixture.driver.call(semanticCallInput({
        maximumCallMs,
        experimentDeadlineMs: Date.now() + 5_000
      }));
      const elapsedMs = Date.now() - startedMs;

      expect(result.failure?.kind).toBe('TIMEOUT');
      expect(result.rawText).toBe('{"ok":true}');
      expect(result.providerStatus).toBe('interrupted');
      expect(result.tokenControl?.usageStatus).toBe('PROVIDER_REPORTED');
      const deadline = result.lifecycle.find(
        (entry) => entry.event === 'absolute-call-deadline-established'
      );
      expect(deadline?.detail).toMatchObject({
        maximumCallMs,
        postDeadlineEvidenceRecoveryMs: 5_500
      });
      expect(
        Date.parse(String(deadline?.detail?.deadlineAt)) - Date.parse(result.submittedAt)
      ).toBe(maximumCallMs);
      // A fresh timeout after setup would take about 900 ms in this fixture.
      // The absolute deadline interrupts near 500 ms and only then retains the
      // terminal/usage evidence sent by the fake provider.
      expect(elapsedMs).toBeLessThan(750);
    } finally {
      await fixture.driver.close();
    }
  });

  it('retains a target overshoot below the safety ceiling without fabricating a failure', async () => {
    const fixture = await semanticFixture('target-overshoot');
    try {
      const result = await fixture.driver.call(semanticCallInput());

      expect(result.failure).toBeUndefined();
      expect(result.rawText).toBe('{"ok":true}');
      expect(result.tokenControl).toMatchObject({
        usageStatus: 'PROVIDER_REPORTED',
        observedOutputTokens: 1_200,
        targetOvershootTokens: 300,
        safetyOvershootTokens: 0
      });
    } finally {
      await fixture.driver.close();
    }
  });

  it('fails closed and preserves output when provider usage crosses the safety ceiling', async () => {
    const fixture = await semanticFixture('safety-overshoot');
    try {
      const result = await fixture.driver.call(semanticCallInput());

      expect(result.failure?.kind).toBe('TOKEN_LIMIT_EXCEEDED');
      expect(result.rawText).toBe('{"ok":true}');
      expect(result.tokenControl).toMatchObject({
        observedOutputTokens: 25_001,
        targetOvershootTokens: 24_101,
        safetyOvershootTokens: 1
      });
      expect(result.lifecycle.map((entry) => entry.event)).toContain('interrupt-submitted');
    } finally {
      await fixture.driver.close();
    }
  });

  it('does not settle a call before a terminal-first interrupt acknowledgement', async () => {
    const fixture = await semanticFixture('terminal-before-interrupt-ack');
    try {
      const result = await fixture.driver.call(semanticCallInput());
      const events = result.lifecycle.map((entry) => entry.event);

      expect(result.failure?.kind).toBe('TOKEN_LIMIT_EXCEEDED');
      expect(result.providerStatus).toBe('interrupted');
      expect(events.indexOf('terminal')).toBeGreaterThan(
        events.indexOf('interrupt-submitted')
      );
      expect(events.indexOf('interrupt-acknowledged')).toBeGreaterThan(
        events.indexOf('terminal')
      );
      expect(events.indexOf('result-recorded')).toBeGreaterThan(
        events.indexOf('interrupt-acknowledged')
      );
    } finally {
      await fixture.driver.close();
    }
  });

  it('bounds a non-timeout safety interrupt acknowledgement by the evidence window', async () => {
    const fixture = await semanticFixture('terminal-before-slow-interrupt-ack');
    try {
      const startedMs = Date.now();
      const result = await fixture.driver.call(semanticCallInput({ maximumCallMs: 200 }));
      const elapsedMs = Date.now() - startedMs;
      const deadline = result.lifecycle.find(
        (entry) => entry.event === 'absolute-call-deadline-established'
      );
      const acknowledged = result.lifecycle.find(
        (entry) => entry.event === 'interrupt-acknowledged'
      );

      expect(result.failure?.kind).toBe('TOKEN_LIMIT_EXCEEDED');
      expect(result.providerStatus).toBe('interrupted');
      expect(deadline).toBeDefined();
      expect(acknowledged).toBeDefined();
      expect(Date.parse(acknowledged!.at)).toBeGreaterThan(
        Date.parse(String(deadline!.detail!.deadlineAt))
      );
      expect(elapsedMs).toBeLessThan(1_000);
    } finally {
      await fixture.driver.close();
    }
  });

  it('fails closed when a terminal-first interrupt is not acknowledged', async () => {
    const fixture = await semanticFixture('terminal-before-interrupt-rejection');
    try {
      const result = await fixture.driver.call(semanticCallInput());

      expect(result.failure).toEqual({
        kind: 'INTERRUPT_UNCONFIRMED',
        message: 'Lab interrupt could not be confirmed: interrupt rejected'
      });
      expect(result.providerStatus).toBe('interrupted');
      expect(result.lifecycle.map((entry) => entry.event)).not.toContain(
        'interrupt-acknowledged'
      );
    } finally {
      await fixture.driver.close().catch(() => undefined);
    }
  });

  it.each([
    ['tool-request', 'TOOL_CONTEXT_VIOLATION', 'Forbidden server request'],
    ['context-compacted', 'TOOL_CONTEXT_VIOLATION', 'Context compacted'],
    ['settings-drift', 'SETTINGS_MISMATCH', 'changed an attested text-lab setting']
  ] as const)('fails closed on %s', async (mode, failureKind, violationText) => {
    const fixture = await semanticFixture(mode);
    try {
      const result = await fixture.driver.call(semanticCallInput());

      expect(result.failure?.kind).toBe(failureKind);
      expect(result.rawText).toBe('{"ok":true}');
      expect(result.violations.some((entry) => entry.includes(violationText))).toBe(true);
      expect(result.lifecycle.map((entry) => entry.event)).toContain('interrupt-submitted');
    } finally {
      await expect(fixture.driver.close()).rejects.toThrow('forbidden boundary events');
    }
  });

  it('latches an MCP event after call completion until process close', async () => {
    const fixture = await semanticFixture('late-mcp-after-terminal');
    let closeAttempted = false;
    try {
      const result = await fixture.driver.call(semanticCallInput());

      expect(result.failure).toBeUndefined();
      expect(result.violations).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(fixture.driver.getProcessBoundaryViolations()).toContain(
        'Forbidden MCP startup event: late-mcp/ready'
      );
      const second = await fixture.driver.call(semanticCallInput({ callKey: 'must-not-run' }));
      expect(second.failure?.kind).toBe('TOOL_CONTEXT_VIOLATION');
      expect(second.providerAccounting.providerTurnStarted).toBe('NO');
      expect(await readCapturedThreadStarts(fixture.capturePath)).toHaveLength(2);
      closeAttempted = true;
      await expect(fixture.driver.close()).rejects.toThrow('forbidden boundary events');
    } finally {
      if (!closeAttempted) {
        await fixture.driver.close().catch(() => undefined);
      }
    }
  });

  it('latches a turn-correlated forbidden event after call removal', async () => {
    const fixture = await semanticFixture('late-compaction-after-terminal');
    let closeAttempted = false;
    try {
      const result = await fixture.driver.call(semanticCallInput());

      expect(result.failure).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 650));
      expect(fixture.driver.getProcessBoundaryViolations()).toContain(
        'Late event after completed call: thread/compacted'
      );
      closeAttempted = true;
      await expect(fixture.driver.close()).rejects.toThrow('forbidden boundary events');
    } finally {
      if (!closeAttempted) {
        await fixture.driver.close().catch(() => undefined);
      }
    }
  });

  it('retains unsolicited interruption as an explicit failure with partial output', async () => {
    const fixture = await semanticFixture('unsolicited-interrupted');
    try {
      const result = await fixture.driver.call(semanticCallInput());

      expect(result.providerStatus).toBe('interrupted');
      expect(result.failure).toEqual({
        kind: 'PROVIDER_ERROR',
        message: 'Codex turn ended with unexpected terminal status: interrupted.'
      });
      expect(result.rawText).toBe('{"ok":true}');
      expect(result.tokenControl?.usageStatus).toBe('PROVIDER_REPORTED');
    } finally {
      await fixture.driver.close();
    }
  });
});

type SemanticFakeMode =
  | 'late-usage'
  | 'fork-timeout'
  | 'timeout-late-usage'
  | 'delayed-thread-start-timeout'
  | 'missing-usage'
  | 'target-overshoot'
  | 'safety-overshoot'
  | 'terminal-before-interrupt-ack'
  | 'terminal-before-slow-interrupt-ack'
  | 'terminal-before-interrupt-rejection'
  | 'tool-request'
  | 'context-compacted'
  | 'settings-drift'
  | 'late-mcp-after-terminal'
  | 'late-compaction-after-terminal'
  | 'unsolicited-interrupted';

async function semanticFixture(mode: SemanticFakeMode): Promise<{
  driver: CodexLabTextDriver;
  capturePath: string;
  fakeServer: string;
  launchArgv: string[][];
}> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-lab-semantic-${mode}-`))
  );
  const codexHome = path.join(root, 'codex-home');
  const executionRoot = path.join(root, 'execution');
  const stateRoot = path.join(root, 'state');
  const fakeServer = path.join(root, 'fake-server.cjs');
  const capturePath = path.join(root, 'thread-starts.jsonl');
  await Promise.all([fs.mkdir(codexHome), fs.mkdir(executionRoot)]);
  await fs.writeFile(fakeServer, semanticFakeAppServer(mode, capturePath), { mode: 0o700 });
  const launchArgv: string[][] = [];

  const driver = new CodexLabTextDriver({
    stateRoot,
    executionRoot,
    codexHome,
    repositoryRoot: process.cwd(),
    appVersion: 'test',
    executable: process.execPath,
    runtimeResolver: async () => ({
      executable: process.execPath,
      source: 'config',
      version: '0.144.6',
      compatibility: {
        launch: { argv: [fakeServer], transport: 'STDIO', form: 'stdio-flag' },
        requiredMethods: []
      },
      diagnostics: []
    }),
    argvResolver: async (input) => {
      const argv = await resolveCodexAppServerArgv(input);
      launchArgv.push(argv);
      return argv;
    }
  });
  const preflight = await driver.preflight({
    model: 'fake-model',
    reasoningEffort: 'medium',
    serviceTier: 'priority'
  });
  expect(preflight.ready).toBe(true);
  expect(preflight.boundary.status).toBe('ATTESTED');
  return { driver, capturePath, fakeServer, launchArgv };
}

function semanticCallInput(
  overrides: Partial<LabTextCallInput> = {}
): LabTextCallInput {
  return {
    callKey: 'semantic-call',
    prompt: 'ordinary text',
    outputSchema: { type: 'object' },
    model: 'fake-model',
    reasoningEffort: 'medium',
    serviceTier: 'priority',
    maximumOutputTokens: 900,
    outputTokenSafetyCeiling: 25_000,
    maximumCallMs: 2_000,
    experimentDeadlineMs: Date.now() + 5_000,
    ...overrides
  };
}

function activeTimeoutCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

async function readCapturedThreadStarts(
  capturePath: string
): Promise<Array<Record<string, unknown>>> {
  return (await fs.readFile(capturePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function threadStartResponse(input: {
  cwd: string;
  serviceTier: string | null;
  instructionSources?: string[];
  runtimeWorkspaceRoots?: string[];
}) {
  return {
    thread: {
      id: 'thread-1',
      sessionId: 'session-1',
      forkedFromId: null,
      parentThreadId: null,
      preview: '',
      ephemeral: true,
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt: 1,
      status: { type: 'idle' },
      path: null,
      cwd: input.cwd,
      cliVersion: '0.144.6',
      source: 'appServer',
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: []
    },
    model: 'fake-model',
    modelProvider: 'openai',
    serviceTier: input.serviceTier,
    cwd: input.cwd,
    runtimeWorkspaceRoots: input.runtimeWorkspaceRoots ?? [input.cwd],
    activePermissionProfile: { id: 'lab-profile', extends: null },
    instructionSources: input.instructionSources ?? [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    reasoningEffort: 'medium'
  };
}

function threadForkResponse(input: {
  cwd: string;
  sourceSession: {
    providerThreadId: string;
    providerSessionTreeId?: string;
  };
  inheritedProviderTurnIds: string[];
}) {
  return {
    ...threadStartResponse({ cwd: input.cwd, serviceTier: 'priority' }),
    thread: {
      ...threadStartResponse({ cwd: input.cwd, serviceTier: 'priority' }).thread,
      id: 'thread-fork',
      sessionId: input.sourceSession.providerSessionTreeId,
      forkedFromId: input.sourceSession.providerThreadId,
      turns: input.inheritedProviderTurnIds.map((id) => ({
        id,
        items: [],
        itemsView: { type: 'complete' },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1
      }))
    }
  };
}

function fakeAppServer(mode: 'instructions' | 'mcp', turnMarker: string): string {
  return `
const fs = require('node:fs');
const readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
const turnMarker = ${JSON.stringify(turnMarker)};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake', codexHome: process.cwd(), platformFamily: 'unix', platformOs: 'macos' } });
      return;
    case 'account/read':
      send({ id: message.id, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: false } });
      return;
    case 'model/list':
      send({ id: message.id, result: { data: [{
        id: 'fake-model', model: 'fake-model', displayName: 'Fake', isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }]
      }], nextCursor: null } });
      return;
    case 'thread/start': {
      const profileId = message.params.config.default_permissions;
      const threadId = 'probe-thread';
      send({ id: message.id, result: {
        thread: {
          id: threadId, sessionId: threadId, forkedFromId: null, parentThreadId: null,
          preview: '', ephemeral: true, modelProvider: 'openai', createdAt: 1, updatedAt: 1,
          status: { type: 'idle' }, path: null, cwd: message.params.cwd,
          cliVersion: '0.144.6', source: 'appServer', threadSource: null,
          agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: []
        },
        model: message.params.model, modelProvider: 'openai',
        serviceTier: message.params.serviceTier, cwd: message.params.cwd,
        runtimeWorkspaceRoots: [message.params.cwd],
        activePermissionProfile: { id: profileId, extends: null },
        instructionSources: mode === 'instructions' ? ['/global/AGENTS.md'] : [],
        approvalPolicy: 'never', approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: message.params.config.model_reasoning_effort
      } });
      if (mode === 'mcp') setTimeout(() => send({
        method: 'mcpServer/startupStatus/updated',
        params: { threadId, name: 'forbidden-server', status: 'ready', error: null }
      }), 0);
      return;
    }
    case 'turn/start':
      fs.writeFileSync(turnMarker, 'submitted');
      send({ id: message.id, result: { turn: { id: 'forbidden-turn', status: 'inProgress', items: [], error: null } } });
      return;
    default:
      send({ id: message.id, result: {} });
  }
});
`;
}

function semanticFakeAppServer(mode: SemanticFakeMode, capturePath: string): string {
  return `
const fs = require('node:fs');
const readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
const capturePath = ${JSON.stringify(capturePath)};
const threads = new Map();
const turns = new Map();
let threadSequence = 0;
let turnSequence = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const turn = (turnId, status) => ({
  id: turnId,
  items: [],
  itemsView: 'full',
  status,
  error: null,
  startedAt: Date.now() / 1000,
  completedAt: status === 'inProgress' ? null : Date.now() / 1000,
  durationMs: status === 'inProgress' ? null : 1
});
const sendStarted = (threadId, turnId) => send({
  method: 'turn/started',
  params: { threadId, turn: turn(turnId, 'inProgress') }
});
const sendOutput = (threadId, turnId) => send({
  method: 'item/completed',
  params: {
    threadId,
    turnId,
    completedAtMs: Date.now(),
    item: {
      type: 'agentMessage',
      id: 'message-' + turnId,
      text: '{"ok":true}',
      phase: null,
      memoryCitation: null
    }
  }
});
const sendUsage = (threadId, turnId, outputTokens) => {
  const usage = {
    totalTokens: outputTokens + 100,
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0
  };
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: { total: usage, last: usage, modelContextWindow: 100000 }
    }
  });
};
const sendTerminal = (threadId, turnId, status = 'completed') => send({
  method: 'turn/completed',
  params: { threadId, turn: turn(turnId, status) }
});
const emitScenario = (threadId, turnId) => {
  sendStarted(threadId, turnId);
  sendOutput(threadId, turnId);
  switch (mode) {
    case 'late-usage':
    case 'fork-timeout':
      sendTerminal(threadId, turnId);
      setTimeout(() => sendUsage(threadId, turnId, 840), 20);
      return;
    case 'timeout-late-usage':
    case 'delayed-thread-start-timeout':
      return;
    case 'missing-usage':
      sendTerminal(threadId, turnId);
      return;
    case 'target-overshoot':
      sendUsage(threadId, turnId, 1200);
      sendTerminal(threadId, turnId);
      return;
    case 'safety-overshoot':
      sendUsage(threadId, turnId, 25001);
      sendTerminal(threadId, turnId);
      return;
    case 'terminal-before-interrupt-ack':
    case 'terminal-before-slow-interrupt-ack':
    case 'terminal-before-interrupt-rejection':
      sendUsage(threadId, turnId, 25001);
      return;
    case 'tool-request':
      send({
        id: 991,
        method: 'item/tool/call',
        params: {
          threadId,
          turnId,
          callId: 'forbidden-tool-call',
          namespace: null,
          tool: 'forbidden',
          arguments: {}
        }
      });
      sendUsage(threadId, turnId, 840);
      sendTerminal(threadId, turnId);
      return;
    case 'context-compacted':
      send({ method: 'thread/compacted', params: { threadId, turnId } });
      sendUsage(threadId, turnId, 840);
      sendTerminal(threadId, turnId);
      return;
    case 'settings-drift': {
      const current = threads.get(threadId);
      send({
        method: 'thread/settings/updated',
        params: {
          threadId,
          threadSettings: {
            cwd: current.params.cwd,
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            sandboxPolicy: { type: 'readOnly', networkAccess: false },
            activePermissionProfile: { id: current.profileId, extends: null },
            model: 'different-model',
            modelProvider: 'openai',
            serviceTier: current.params.serviceTier,
            effort: current.params.config.model_reasoning_effort,
            summary: null,
            collaborationMode: { mode: 'default', settings: {} },
            personality: null
          }
        }
      });
      sendUsage(threadId, turnId, 840);
      sendTerminal(threadId, turnId);
      return;
    }
    case 'late-mcp-after-terminal':
      sendUsage(threadId, turnId, 840);
      sendTerminal(threadId, turnId);
      setTimeout(() => send({
        method: 'mcpServer/startupStatus/updated',
        params: {
          threadId,
          name: 'late-mcp',
          status: 'ready',
          error: null,
          failureReason: null
        }
      }), 100);
      return;
    case 'late-compaction-after-terminal':
      sendUsage(threadId, turnId, 840);
      sendTerminal(threadId, turnId);
      setTimeout(() => send({
        method: 'thread/compacted',
        params: { threadId, turnId }
      }), 500);
      return;
    case 'unsolicited-interrupted':
      sendUsage(threadId, turnId, 840);
      sendTerminal(threadId, turnId, 'interrupted');
      return;
  }
};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message) || typeof message.method !== 'string') return;
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: {
        userAgent: 'fake', codexHome: process.cwd(), platformFamily: 'unix', platformOs: 'macos'
      } });
      return;
    case 'account/read':
      send({ id: message.id, result: {
        account: { type: 'apiKey' }, requiresOpenaiAuth: false
      } });
      return;
    case 'model/list':
      send({ id: message.id, result: { data: [{
        id: 'fake-model',
        model: 'fake-model',
        displayName: 'Fake',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }]
      }], nextCursor: null } });
      return;
    case 'thread/start': {
      threadSequence += 1;
      const threadId = 'thread-' + threadSequence;
      const sessionId = 'session-' + threadSequence;
      const profileId = message.params.config.default_permissions;
      fs.appendFileSync(capturePath, JSON.stringify(message.params) + '\\n');
      threads.set(threadId, { profileId, params: message.params, sessionId, turnIds: [] });
      const respond = () => send({ id: message.id, result: {
          thread: {
            id: threadId,
            sessionId,
            forkedFromId: null,
            parentThreadId: null,
            preview: '',
            ephemeral: true,
            modelProvider: 'openai',
            createdAt: 1,
            updatedAt: 1,
            status: { type: 'idle' },
            path: null,
            cwd: message.params.cwd,
            cliVersion: '0.144.6',
            source: 'appServer',
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: []
          },
          model: message.params.model,
          modelProvider: 'openai',
          serviceTier: message.params.serviceTier,
          cwd: message.params.cwd,
          runtimeWorkspaceRoots: [message.params.cwd],
          activePermissionProfile: { id: profileId, extends: null },
          instructionSources: [],
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly', networkAccess: false },
          reasoningEffort: message.params.config.model_reasoning_effort
        } });
      if (mode === 'delayed-thread-start-timeout') setTimeout(respond, 300);
      else respond();
      return;
    }
    case 'thread/fork': {
      if (mode === 'fork-timeout') return;
      const source = threads.get(message.params.threadId);
      if (!source) {
        send({ id: message.id, error: { code: -32000, message: 'unknown source' } });
        return;
      }
      threadSequence += 1;
      const threadId = 'thread-' + threadSequence;
      const profileId = message.params.config.default_permissions;
      threads.set(threadId, {
        profileId,
        params: message.params,
        sessionId: source.sessionId,
        turnIds: [...source.turnIds]
      });
      send({ id: message.id, result: {
        thread: {
          id: threadId,
          sessionId: source.sessionId,
          forkedFromId: message.params.threadId,
          parentThreadId: null,
          preview: '',
          ephemeral: true,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: message.params.cwd,
          cliVersion: '0.144.6',
          source: 'appServer',
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: source.turnIds.map((turnId) => turn(turnId, 'completed'))
        },
        model: message.params.model,
        modelProvider: 'openai',
        serviceTier: message.params.serviceTier,
        cwd: message.params.cwd,
        runtimeWorkspaceRoots: [message.params.cwd],
        activePermissionProfile: { id: profileId, extends: null },
        instructionSources: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: message.params.config.model_reasoning_effort
      } });
      return;
    }
    case 'turn/start': {
      turnSequence += 1;
      const turnId = 'turn-' + turnSequence;
      turns.set(turnId, { threadId: message.params.threadId });
      const current = threads.get(message.params.threadId);
      if (current) current.turnIds.push(turnId);
      send({ id: message.id, result: { turn: turn(turnId, 'inProgress') } });
      setTimeout(() => emitScenario(message.params.threadId, turnId), 10);
      return;
    }
    case 'turn/interrupt': {
      const active = turns.get(message.params.turnId);
      if (
        (mode === 'terminal-before-interrupt-ack' ||
          mode === 'terminal-before-slow-interrupt-ack' ||
          mode === 'terminal-before-interrupt-rejection') &&
        active
      ) {
        sendTerminal(active.threadId, message.params.turnId, 'interrupted');
        setTimeout(() => {
          if (mode === 'terminal-before-interrupt-rejection') {
            send({
              id: message.id,
              error: { code: -32000, message: 'interrupt rejected' }
            });
          } else {
            send({ id: message.id, result: {} });
          }
        }, mode === 'terminal-before-slow-interrupt-ack' ? 250 : 50);
        return;
      }
      send({ id: message.id, result: {} });
      if (
        (mode === 'timeout-late-usage' || mode === 'delayed-thread-start-timeout') &&
        active
      ) {
        setTimeout(() => {
          sendTerminal(active.threadId, message.params.turnId, 'interrupted');
          setTimeout(() => sendUsage(active.threadId, message.params.turnId, 840), 20);
        }, 0);
      }
      return;
    }
    default:
      send({ id: message.id, result: {} });
  }
});
`;
}
