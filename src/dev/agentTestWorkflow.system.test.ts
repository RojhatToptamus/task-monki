import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runAgentTestWorkflow } from './agentTestWorkflow';

describe('deterministic agent test workflow', () => {
  it('executes managed and external work through provider processes and joins owned resources', async () => {
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
    expect(report.attachedWork).toMatchObject({
      initialPhase: 'IN_PROGRESS',
      importStartedNoAgent: true,
      indexAndConfigPreserved: true,
      review: {
        runtimeId: 'codex',
        stableStatus: 'PASSED',
        changedDuringReviewStatus: expect.stringMatching(/^(STALE|INCONCLUSIVE)$/),
        noPrimaryRun: true
      },
      deletionPreservedCheckoutAndServer: true
    });
    expect(report.attachedWork.review.processId).toBeGreaterThan(0);
    expect(report.attachedWork.preview).toMatchObject(process.platform === 'darwin'
      ? { attempted: true, staleCapturePreserved: true, replacementServedNewBytes: true, processesJoined: true }
      : { attempted: false, skippedReason: expect.stringContaining('requires macOS') });
    expect(report.cleanup).toEqual({
      serviceStopped: true,
      uiStopped: true,
      rootRemoved: true
    });
    await expect(fs.access(report.rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);
});
