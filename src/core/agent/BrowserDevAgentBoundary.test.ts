import { describe, expect, it } from 'vitest';
import type {
  AgentRuntimeCapabilities,
  AgentRuntimeDescriptor
} from '../../shared/contracts';
import {
  assertBrowserDevRuntimeIsolation,
  BROWSER_DEV_ISOLATION_CAPABILITY,
  hasBrowserDevRuntimeIsolation
} from './BrowserDevAgentBoundary';

describe('browser development runtime isolation', () => {
  const descriptor: AgentRuntimeDescriptor = {
    id: 'test-runtime',
    displayName: 'Test Runtime',
    kind: 'ACP_AGENT',
    transport: 'STDIO',
    lifecycleScope: 'APPLICATION'
  };

  it('requires a stable runtime attestation instead of inferring safety from settings', () => {
    const capabilities = unsupportedCapabilities();
    expect(() => assertBrowserDevRuntimeIsolation(descriptor, capabilities)).toThrow(
      'does not attest the process, filesystem, and network isolation'
    );
    expect(hasBrowserDevRuntimeIsolation(capabilities)).toBe(false);

    capabilities.extensions[BROWSER_DEV_ISOLATION_CAPABILITY] = {
      maturity: 'stable'
    };
    expect(() =>
      assertBrowserDevRuntimeIsolation(descriptor, capabilities)
    ).not.toThrow();
    expect(hasBrowserDevRuntimeIsolation(capabilities)).toBe(true);
  });
});

function unsupportedCapabilities(): AgentRuntimeCapabilities {
  const unsupported = { maturity: 'unsupported' as const };
  return {
    runtimeId: 'test-runtime',
    executionPolicy: {
      defaultPresetId: 'read-only',
      detail: 'Test policy.',
      presets: [
        {
          id: 'read-only',
          label: 'Read only',
          detail: 'Test read-only policy.',
          sandbox: 'READ_ONLY',
          repositoryMutation: 'DENY',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          networkAccess: 'DISABLED'
        }
      ]
    },
    readOnlyTurns: unsupported,
    modelCatalog: unsupported,
    activeTurnSteering: unsupported,
    turnInterruption: unsupported,
    attachmentDelivery: unsupported,
    extensions: {}
  };
}
