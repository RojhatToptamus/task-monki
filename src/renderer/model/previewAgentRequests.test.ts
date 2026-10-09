import { expect, it } from 'vitest';
import { investigationRequest, proposalSummary } from './previewAgentRequests';

it('counts what a proposal runs by service kind', () => {
  expect(proposalSummary('name: a\ntype: environment\nprimary: web\nservices:\n  install: {type: job}\n  web: {type: command}\n  api: {type: command}\n  db: {type: postgres}\n'))
    .toBe('1 step, 2 servers, 1 database');
  expect(proposalSummary('name: a\ntype: static\ndirectory: .\n')).toBe('1 static site');
  expect(proposalSummary('services: [')).toBeUndefined();
});

it('asks the agent to investigate a failure without executing anything', () => {
  expect(investigationRequest({ service: 'web', title: 'web exited with code 1', observed: 'Port in use.' }))
    .toBe('Investigate the web failure: web exited with code 1. Port in use. Propose a configuration change for review if the configuration caused it; otherwise explain what the project code needs.');
});
