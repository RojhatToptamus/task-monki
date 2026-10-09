import { expect, it } from 'vitest';
import type { AttemptSummary } from 'previewhost';
import type { ApplicationPreviewSnapshot } from '../../shared/applicationPreview';
import { previewBlockerCount, previewStatusRow, type PreviewStatusRowInput } from './applicationPreviewPanel';

const attempt = (state: AttemptSummary['state'], id = 'run'): AttemptSummary => ({
  id, type: 'environment', state, startedAt: '2026-10-09T12:00:00Z', sources: []
});
const base: PreviewStatusRowInput = {
  snapshot: { name: 'app', hasConfigurationFile: true },
  unavailable: false,
  worktree: { state: 'available' },
  dirty: false,
  proposal: false,
  blockers: 0,
  busy: false
};
const row = (overrides: Partial<PreviewStatusRowInput>, snapshot?: Partial<ApplicationPreviewSnapshot>) =>
  previewStatusRow({
    ...base,
    ...overrides,
    snapshot: snapshot ? { name: 'app', hasConfigurationFile: true, ...snapshot } : 'snapshot' in overrides ? overrides.snapshot : base.snapshot
  });

it('gives every state exactly one primary and names it from what exists', () => {
  expect(row({ worktree: { state: 'missing', external: false, pending: false } })).toMatchObject({
    chip: { label: 'Worktree missing' }, primary: { action: 'restore-worktree', label: 'Restore worktree' }, secondary: []
  });
  expect(row({ worktree: { state: 'missing', external: true, pending: false } }).primary?.action).toBe('reconnect-checkout');
  expect(row({ worktree: { state: 'absent', pending: true } })).toMatchObject({ chip: { label: 'Preparing' }, primary: { disabled: true } });
  expect(row({}, { hasConfigurationFile: false })).toMatchObject({
    chip: { label: 'Not configured' }, primary: { action: 'draft' }, secondary: [{ action: 'write', label: 'Write it myself' }]
  });
  expect(row({ agentWorking: true }, { hasConfigurationFile: false }).primary).toMatchObject({ action: 'draft', disabled: true });
  expect(row({ agentDisabledReason: 'No agent' }, { hasConfigurationFile: false })).toMatchObject({
    primary: { action: 'write', label: 'Write preview.yaml' }, secondary: []
  });
  expect(row({}, { hasConfigurationFile: false, status: { name: 'app', busy: false, latest: attempt('stopped') } })).toMatchObject({
    chip: { label: 'Stopped' }, primary: { action: 'start-retained', label: 'Start from last run' }, secondary: [{ action: 'draft' }]
  });
  expect(row({ dirty: true })).toMatchObject({
    chip: { label: 'Unsaved changes' }, primary: { action: 'save-and-review' }, secondary: [{ action: 'discard' }, { action: 'save' }]
  });
  expect(row({ dirty: true, proposal: true }).chip.label).toBe('Proposal ready');
  expect(row({ blockers: 2 })).toMatchObject({
    chip: { label: 'Not running' }, reason: '2 to resolve first', primary: { action: 'start', disabled: true, disabledReason: 'Resolve 2 requirements before starting.' }
  });
  expect(row({}, { configurationError: 'Unknown service type' }).primary).toMatchObject({ disabled: true, disabledReason: 'Unknown service type' });
  const approval = { attemptId: 'pending', description: {} as never, secrets: [] };
  expect(row({}, { approval, status: { name: 'app', busy: false, candidate: attempt('starting', 'pending') } })).toMatchObject({
    chip: { label: 'Approval needed' }, primary: { action: 'approve', label: 'Approve and start' }, secondary: [{ action: 'cancel' }]
  });
  expect(row({ blockers: 1 }, { approval, status: { name: 'app', busy: false, candidate: attempt('starting', 'pending') } }).primary?.disabled).toBe(true);
  expect(row({}, { status: { name: 'app', busy: false, candidate: attempt('starting') } })).toMatchObject({ chip: { label: 'Starting' }, secondary: [{ action: 'cancel' }] });
  expect(row({}, { status: { name: 'app', busy: false, url: 'http://127.0.0.1:1', active: attempt('ready') } })).toMatchObject({
    chip: { label: 'Ready' }, url: 'http://127.0.0.1:1', primary: { action: 'open', label: 'Open app' }, secondary: [{ action: 'stop' }]
  });
  expect(row({}, { restartReview: { id: 'r', description: {} as never, affected: [] }, status: { name: 'app', busy: false, url: 'http://127.0.0.1:1', active: attempt('ready') } })).toMatchObject({
    chip: { label: 'Restart review' }, primary: { label: 'Approve restart' }
  });
  expect(row({}, { status: { name: 'app', busy: false, latest: attempt('failed') } })).toMatchObject({ chip: { label: 'Startup failed' }, primary: { label: 'Start again' } });
  expect(row({}, { status: { name: 'app', busy: false, url: 'http://127.0.0.1:1', active: attempt('ready', 'old'), latest: attempt('failed') } })).toMatchObject({
    chip: { label: 'Update failed' }, primary: { action: 'open' }
  });
  expect(row({}, { restoredRun: true, status: { name: 'app', busy: false, latest: attempt('stopped') } })).toMatchObject({ chip: { label: 'Stopped' }, primary: { label: 'Start preview' } });
  expect(row({ snapshot: undefined }).primary).toMatchObject({ disabled: true });
  expect(row({ unavailable: true })).toMatchObject({ chip: { label: 'Unavailable' } });
  expect(row({ unavailable: true }).primary).toBeUndefined();
});

it('counts one blocker per folder, one for storage, and one per missing value', () => {
  expect(previewBlockerCount({
    storage: { services: ['database'], state: 'locked' },
    secrets: [
      { id: 'a', selected: false, bindings: [], availability: 'locked' },
      { id: 'b', selected: false, bindings: [], availability: 'missing' }
    ],
    connections: ['api'],
    sources: [
      { service: 'api', declaration: '../backend', directory: '/backend', connected: false },
      { service: 'migrate', declaration: '../backend', directory: '/backend', connected: false },
      { service: 'web', declaration: '.', directory: '/web', connected: true }
    ]
  })).toBe(4);
  expect(previewBlockerCount(undefined)).toBe(0);
});
