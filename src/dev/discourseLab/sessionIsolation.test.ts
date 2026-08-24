import { describe, expect, it } from 'vitest';
import { controlledSessionIsolationProblem } from './experiments';
import type { LabCallAccountingRecord, LabProtocolRunResult } from './runner';

describe('controlled H1 provider-session isolation', () => {
  it('accepts distinct attested primary threads and rejects reuse across assignments', () => {
    const owners = new Map<string, string>();

    expect(
      controlledSessionIsolationProblem('assignment-a', runWith(primary('thread-a')), owners)
    ).toBeUndefined();
    expect(
      controlledSessionIsolationProblem('assignment-b', runWith(primary('thread-b')), owners)
    ).toBeUndefined();
    expect(
      controlledSessionIsolationProblem('assignment-c', runWith(primary('thread-a')), owners)
    ).toContain('reused provider thread thread-a from assignment-a');
  });

  it('fails a successful primary call without an attested fresh session', () => {
    const attempt = primary(null);
    attempt.sessionAttestation = 'NOT_PRESENT';
    attempt.threadStartStatus = 'NOT_STARTED';
    attempt.providerTurnStarted = 'UNKNOWN';

    expect(
      controlledSessionIsolationProblem('assignment-a', runWith(attempt), new Map())
    ).toContain('lacks an attested fresh primary provider session');
  });
});

function primary(providerThreadId: string | null): LabCallAccountingRecord {
  return {
    assignedCallId: 'CONTROL_RESPONSE',
    purpose: 'PRIMARY',
    callKey: 'assignment:test:case:condition:CONTROL_RESPONSE',
    promptArtifactSha256: 'a'.repeat(64),
    dispatched: true,
    threadStartRequested: true,
    threadStartStatus: 'ATTESTED',
    sessionAttestation: 'ATTESTED',
    providerThreadId,
    providerTurnStarted: 'YES',
    providerTurnId: 'turn-1',
    billableModelCall: 'YES',
    failure: null,
    violations: [],
    lifecycle: []
  };
}

function runWith(attempt: LabCallAccountingRecord): LabProtocolRunResult {
  return { callAccounting: [attempt] } as LabProtocolRunResult;
}
