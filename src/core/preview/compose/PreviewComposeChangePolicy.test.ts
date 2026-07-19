import { describe, expect, it } from 'vitest';
import type { PreviewComposeInspection } from '../../../shared/contracts';
import { classifyPreviewComposeChange } from './PreviewComposeChangePolicy';

describe('classifyPreviewComposeChange', () => {
  it('allows stateless command changes in place', () => {
    const previous = inspection();
    const next = inspection({ command: ['node', 'new-server.mjs'], configDigest: 'next' });
    expect(classifyPreviewComposeChange(previous, next).kind).toBe('IN_PLACE_UPDATE');
  });

  it('restarts for topology changes while preserving verified volumes', () => {
    const previous = inspection();
    const next = inspection({ dependsOn: ['cache'], configDigest: 'next' });
    expect(classifyPreviewComposeChange(previous, next).kind).toBe('RESTART_PRESERVE_DATA');
  });

  it('requires explicit reset for unproven data-service compatibility', () => {
    const previous = inspection({ data: true });
    const next = inspection({ data: true, image: 'postgres:18', configDigest: 'next' });
    expect(classifyPreviewComposeChange(previous, next)).toEqual(expect.objectContaining({
      kind: 'DESTRUCTIVE_RESET_REQUIRED',
      reasons: [expect.stringContaining('Data-bearing service')]
    }));
  });

  it('never treats driver or external-ownership changes as an ordinary restart', () => {
    const previous = inspection({ data: true });
    const next = inspection({ data: true, volumeDriver: 'custom', configDigest: 'next' });
    expect(classifyPreviewComposeChange(previous, next).kind).toBe('DESTRUCTIVE_RESET_REQUIRED');
  });
});

function inspection(input: {
  command?: string[];
  dependsOn?: string[];
  image?: string;
  data?: boolean;
  volumeDriver?: string;
  configDigest?: string;
} = {}): PreviewComposeInspection {
  return {
    composeVersion: '2.40.0',
    supportsNoEnvResolution: true,
    trustDigest: 'trust',
    configDigest: input.configDigest ?? 'config',
    hostInputs: [{ kind: 'COMPOSE_FILE', path: 'compose.yaml' }],
    services: [{
      id: 'web',
      image: input.image ?? 'node:22',
      command: input.command ?? ['node', 'server.mjs'],
      dependsOn: (input.dependsOn ?? []).map((service) => ({
        service, condition: 'service_started' as const, required: true, restart: false
      })),
      environmentKeys: [],
      exposedPorts: [3000],
      secretSources: [],
      namedVolumes: input.data ? [{ source: 'data', target: '/data', readOnly: false }] : [],
      networks: ['default'],
      healthcheck: { test: ['CMD', 'true'] }
    }],
    volumes: input.data ? [{ name: 'data', external: false, driver: input.volumeDriver }] : [],
    networks: [{ name: 'default', external: false }]
  };
}
