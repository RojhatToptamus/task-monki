import { describe, expect, it } from 'vitest';
import { CODEX_RUNTIME_DESCRIPTOR } from './codex/codexCapabilities';
import {
  appendRuntimeDiagnostic,
  createRuntimeReadiness,
  errorDiagnostic,
  warningDiagnostic
} from './AgentRuntimeReadiness';

describe('AgentRuntimeReadiness', () => {
  it('uses the new status summary and diagnostic detail on a readiness transition', () => {
    const ready = {
      runtime: CODEX_RUNTIME_DESCRIPTOR,
      readiness: createRuntimeReadiness('READY', 'The runtime is operational.'),
      capabilities: {} as never
    };

    const degraded = appendRuntimeDiagnostic(
      ready,
      warningDiagnostic(
        'EVENT_MATERIALIZATION_FAILED',
        'HEALTH',
        'Provider events could not be materialized.'
      ),
      'DEGRADED'
    );
    expect(degraded.readiness).toMatchObject({
      status: 'DEGRADED',
      summary: 'Degraded',
      detail: 'Provider events could not be materialized.'
    });

    const failed = appendRuntimeDiagnostic(
      degraded,
      errorDiagnostic(
        'RUNTIME_QUARANTINE_FAILED',
        'HEALTH',
        'The provider process could not be quarantined.'
      ),
      'FAILED'
    );
    expect(failed.readiness).toMatchObject({
      status: 'FAILED',
      summary: 'Unavailable',
      detail: 'The provider process could not be quarantined.'
    });
  });

  it('preserves a custom summary when only diagnostics change', () => {
    const preflight = {
      runtime: CODEX_RUNTIME_DESCRIPTOR,
      readiness: createRuntimeReadiness('READY', 'Still operational.', {
        summary: 'Custom ready'
      }),
      capabilities: {} as never
    };
    expect(
      appendRuntimeDiagnostic(
        preflight,
        warningDiagnostic('NOTICE', 'HEALTH', 'A non-blocking warning.')
      ).readiness
    ).toMatchObject({
      status: 'READY',
      summary: 'Custom ready',
      detail: 'Still operational.'
    });
  });
});
