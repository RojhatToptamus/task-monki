import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreviewComposePlan } from '../../../shared/contracts';
import { PreviewComposeInspector } from './PreviewComposeInspector';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const plan: PreviewComposePlan = {
  files: ['compose.yaml'],
  projectDirectory: '.',
  profiles: [],
  rootServices: ['web'],
  services: [{
    id: 'web',
    ports: { http: { target: 3000, protocol: 'tcp' } },
    ready: { type: 'tcp', port: 'http', timeoutSeconds: 10 }
  }]
};

describe('PreviewComposeInspector', () => {
  it('runs two feature-gated passes and keeps materialized environment values out of the plan', async () => {
    const root = await fixture(`
services:
  web:
    image: alpine:3.21
    command: [node, server.mjs]
    env_file: [preview.env]
    expose: [3000]
    volumes: [data:/data]
volumes: { data: {} }
`);
    await fs.writeFile(path.join(root, 'preview.env'), 'VISIBLE_KEY=plaintext-canary\n', { mode: 0o600 });
    const calls: boolean[] = [];
    const cli = {
      async probe() { return { version: '2.40.0', supportsNoEnvResolution: true }; },
      async config(_command: unknown, options: { materialized: boolean }) {
        calls.push(options.materialized);
        return JSON.stringify({
          services: {
            web: {
              image: 'alpine:3.21',
              command: ['node', 'server.mjs'],
              environment: { VISIBLE_KEY: options.materialized ? 'plaintext-canary' : '${VISIBLE_KEY}' },
              expose: ['3000/tcp'],
              volumes: [{ type: 'volume', source: 'data', target: '/data' }],
              networks: ['default']
            }
          },
          volumes: { data: {} },
          networks: { default: {} }
        });
      }
    };
    const inspector = new PreviewComposeInspector(cli as never, path.join(root, '.control'));
    const inspected = await inspector.inspect({ sourceRoot: root, contextName: 'desktop-linux', projectName: 'taskmonki_test', plan });
    expect(calls).toEqual([false, true]);
    expect(inspected.composeVersion).toBe('2.40.0');
    expect(inspected.services[0]?.environmentKeys).toEqual(['VISIBLE_KEY']);
    expect(inspected.hostInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'COMPOSE_FILE', path: 'compose.yaml' }),
      expect.objectContaining({ kind: 'ENV_FILE', path: 'preview.env' })
    ]));
    expect(JSON.stringify(inspected)).not.toContain('plaintext-canary');
    expect(JSON.stringify(inspected)).not.toContain('${VISIBLE_KEY}');
  });

  it('fails before config normalization when no-env-resolution is unavailable', async () => {
    const root = await fixture('services: { web: { image: alpine, expose: [3000] } }\n');
    let configCalls = 0;
    const inspector = new PreviewComposeInspector({
      async probe() { return { version: '2.34.0', supportsNoEnvResolution: false }; },
      async config() { configCalls += 1; return '{}'; }
    } as never, path.join(root, '.control'));
    await expect(inspector.inspect({ sourceRoot: root, contextName: 'desktop-linux', projectName: 'taskmonki_test', plan }))
      .rejects.toThrow('--no-env-resolution');
    expect(configCalls).toBe(0);
  });

  it.each([
    ['include', 'include: [other.yaml]\nservices: {}\n'],
    ['bind mount', 'services: { web: { image: alpine, volumes: [./src:/app] } }\n'],
    ['source port', 'services: { web: { image: alpine, ports: [8080:3000] } }\n'],
    ['environment secret', 'services: { web: { image: alpine } }\nsecrets: { token: { environment: TOKEN } }\n'],
    ['secret target authority', 'services: { web: { image: alpine } }\nsecrets: { token: { file: token.txt, name: custom } }\n'],
    ['volume labels', 'services: { web: { image: alpine } }\nvolumes: { data: { labels: [custom=yes] } }\n'],
    ['network driver', 'services: { web: { image: alpine } }\nnetworks: { default: { driver: overlay } }\n'],
    ['restart policy', 'services: { web: { image: alpine, restart: always } }\n']
  ])('rejects unsupported host or lifecycle authority: %s', async (_label, composeSource) => {
    const root = await fixture(composeSource);
    const inspector = new PreviewComposeInspector({
      async probe() { throw new Error('must not probe'); }
    } as never, path.join(root, '.control'));
    await expect(inspector.inspect({ sourceRoot: root, contextName: 'desktop-linux', projectName: 'taskmonki_test', plan }))
      .rejects.toThrow();
  });
});

async function fixture(composeSource: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-compose-inspector-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'compose.yaml'), composeSource);
  return root;
}
