import { describe, expect, it } from 'vitest';
import { AgentMutationAmbiguousError } from '../AgentRuntimeAdapter';
import type { AgentRuntimeReadinessChecks } from '../../../shared/agent';
import {
  AcpSessionContractError,
  acpSessionFailureReadiness
} from './AcpRuntimeAdapter';
import { TEST_ACP_PROFILE } from '../../../testSupport/acpRuntimeProfile';

const initializedChecks: AgentRuntimeReadinessChecks = {
  discovery: 'FOUND',
  compatibility: 'COMPATIBLE',
  initialization: 'INITIALIZED',
  authentication: 'PROVIDER_MANAGED',
  modelCatalog: 'UNKNOWN'
};

describe('ACP session readiness classification', () => {
  it('classifies malformed negotiated responses as incompatible', () => {
    const readiness = acpSessionFailureReadiness(
      TEST_ACP_PROFILE,
      new AcpSessionContractError(
        'session/new',
        'session/new response did not contain a string sessionId'
      ),
      initializedChecks,
      false
    );

    expect(readiness).toMatchObject({
      status: 'INCOMPATIBLE',
      canStart: false,
      checks: {
        compatibility: 'INCOMPATIBLE',
        initialization: 'FAILED',
        authentication: 'UNKNOWN',
        modelCatalog: 'FAILED'
      },
      nextAction: { kind: 'CONFIGURE' }
    });
    expect(readiness.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ACP_SESSION_CONTRACT_INCOMPATIBLE' })
      ])
    );
  });

  it('classifies quarantined ambiguous mutations as recoverable degradation', () => {
    const readiness = acpSessionFailureReadiness(
      TEST_ACP_PROFILE,
      new AgentMutationAmbiguousError(
        'session/new',
        'ACP mutation timed out after submission: session/new'
      ),
      initializedChecks,
      false
    );

    expect(readiness).toMatchObject({
      status: 'DEGRADED',
      canStart: true,
      checks: {
        compatibility: 'COMPATIBLE',
        initialization: 'FAILED',
        authentication: 'PROVIDER_MANAGED',
        modelCatalog: 'UNKNOWN'
      },
      nextAction: { kind: 'RETRY' }
    });
  });

  it('distinguishes sign-in failures from generic provider session failures', () => {
    const authentication = acpSessionFailureReadiness(
      TEST_ACP_PROFILE,
      new Error('Unauthorized: sign in before creating a session.'),
      initializedChecks
    );
    const providerFailure = acpSessionFailureReadiness(
      TEST_ACP_PROFILE,
      new Error('Provider session allocation is temporarily unavailable.'),
      initializedChecks
    );

    expect(authentication).toMatchObject({
      status: 'AUTHENTICATION_REQUIRED',
      checks: { authentication: 'REQUIRED', modelCatalog: 'UNKNOWN' },
      nextAction: { kind: 'AUTHENTICATE' }
    });
    expect(providerFailure).toMatchObject({
      status: 'FAILED',
      checks: { authentication: 'UNKNOWN', modelCatalog: 'FAILED' },
      nextAction: { kind: 'RETRY' }
    });
  });
});
