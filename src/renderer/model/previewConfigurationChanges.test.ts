import { expect, it } from 'vitest';
import { previewConfigurationChanges } from './previewConfigurationChanges';

const running = `name: app
type: environment
primary: web
services:
  install: {type: job, cwd: ., command: [npm, ci]}
  web:
    type: command
    cwd: .
    command: [npm, run, dev]
    readyPath: /ready
    env:
      API_URL: http://127.0.0.1:8001
`;

it('lists service-level changes with values for fields and only names for environment variables', () => {
  const next = running
    .replace('readyPath: /ready', 'readyPath: /health')
    .replace('API_URL: http://127.0.0.1:8001', 'API_URL: http://127.0.0.1:8002\n      FEATURE_DARK_MODE: "1"')
    + '  cache: {type: redis}\n';
  expect(previewConfigurationChanges(running, next)).toEqual([
    { service: 'web', change: 'ready at /health, was /ready' },
    { service: 'web', change: 'variable API_URL changed', concealed: true },
    { service: 'web', change: 'new variable FEATURE_DARK_MODE', concealed: true },
    { service: 'cache', change: 'new redis' }
  ]);
  expect(JSON.stringify(previewConfigurationChanges(running, next))).not.toContain('8002');
});

it('names a change to the primary service, which reroutes the preview, instead of reporting no changes', () => {
  const twoServers = running + '  api: {type: command, cwd: ., command: [node, api.js], readyPath: /health}\n';
  expect(previewConfigurationChanges(twoServers, twoServers.replace('primary: web', 'primary: api'))).toEqual([
    { service: 'preview.yaml', change: 'primary service api, was web' }
  ]);
  expect(previewConfigurationChanges(running, 'name: app\ntype: command\ncwd: .\ncommand: [npm, start]\n')).toEqual([
    { service: 'preview.yaml', change: 'type command, was environment' }
  ]);
});

it('reports removed services and gives up on invalid YAML', () => {
  expect(previewConfigurationChanges(running, running.replace(/  install:.*\n/, ''))).toEqual([{ service: 'install', change: 'removed' }]);
  expect(previewConfigurationChanges(running, 'services: [')).toBeUndefined();
  expect(previewConfigurationChanges(running, running)).toEqual([]);
});


it('conceals probe environments and connection credentials in restart changes', () => {
  const before = running + '  external: {type: attach, url: "http://user:old-password@localhost:8000"}\n';
  const after = before.replace('old-password', 'new-password').replace('readyPath: /ready', 'ready: {type: command, command: [node, health.js], env: {HEALTH_KEY: private-health-value}}');
  const changes = previewConfigurationChanges(before, after)!;
  expect(changes.some((item) => item.service === 'web')).toBe(true);
  expect(changes.some((item) => item.service === 'external')).toBe(true);
  expect(JSON.stringify(changes)).not.toMatch(/old-password|new-password|private-health-value/);
});
