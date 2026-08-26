import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runAgentTestWorkflow } from './agentTestWorkflow';

describe('deterministic agent test workflow', () => {
  it('crosses the real ACP process boundary, observes Git, and removes its root', async () => {
    const report = await runAgentTestWorkflow();

    expect(report.verdict).toBe('PASSED');
    expect(report.scenarios.map((scenario) => scenario.runStatus)).toEqual([
      'COMPLETED',
      'FAILED',
      'INTERRUPTED'
    ]);
    expect(report.runtime.processWasObserved).toBe(true);
    expect(report.runtime.processJoined).toBe(true);
    expect(report.runtime.serverCount).toBe(1);
    expect(report.runtime.providerStartCount).toBe(1);
    expect(report.runtime.processIds.length).toBeGreaterThan(0);
    expect(report.runtime.providerLogTail).toContain('"event":"network-guard-installed"');
    expect(report.runtime.protocolMethods).toEqual(
      expect.arrayContaining([
        'initialize',
        'session/new',
        'session/prompt',
        'session/cancel'
      ])
    );
    expect(report.scenarios[0]).toMatchObject({
      workflowPhase: 'REVIEW',
      providerItemTypes: expect.arrayContaining(['AGENT_MESSAGE', 'FILE_CHANGE']),
      git: {
        untrackedCount: 1,
        changedPaths: ['agent-output.txt'],
        expectedChangeObserved: true
      }
    });
    expect(report.scenarios[1]).toMatchObject({
      workflowPhase: 'IN_PROGRESS',
      runStatus: 'FAILED',
      git: { expectedChangeObserved: true }
    });
    expect(report.scenarios[1]?.diagnostic).toMatch(/token/i);
    expect(report.scenarios[2]).toMatchObject({
      workflowPhase: 'IN_PROGRESS',
      runStatus: 'INTERRUPTED',
      git: { expectedChangeObserved: true }
    });
    expect(report.sourceRepository).toMatchObject({
      clean: true,
      unchanged: true
    });
    expect(report.cleanup).toEqual({
      serviceStopped: true,
      uiStopped: true,
      rootRemoved: true
    });
    await expect(fs.access(report.rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);
});
