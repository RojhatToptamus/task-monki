import { expect, it } from 'vitest';
import type { RunRecord } from '../../shared/contracts';
import { initialPreviewAgentSelection } from './previewAgentSelection';

const defaults = { runtimeId: 'codex', model: 'gpt-default', modelProvider: 'openai', reasoningEffort: 'low' };
const run = (model: string, startedAt: string): RunRecord =>
  ({ runtimeId: 'codex', requestedSettings: { model, modelProvider: 'openai', reasoningEffort: 'high' }, startedAt, mode: 'PREVIEW' } as RunRecord);

it('starts from Settings, then follows the latest requested Preview conversation', () => {
  expect(initialPreviewAgentSelection([], defaults))
    .toEqual({ runtimeId: 'codex', model: 'gpt-default', modelProvider: 'openai', reasoningEffort: 'low' });
  expect(initialPreviewAgentSelection([], { runtimeId: 'opencode' }).runtimeId).toBe('opencode');
  expect(initialPreviewAgentSelection([
    run('gpt-fast', '2026-10-09T10:00:00Z'), run('gpt-old', '2026-10-09T09:00:00Z')
  ], { runtimeId: 'opencode' }))
    .toEqual({ runtimeId: 'codex', model: 'gpt-fast', modelProvider: 'openai', reasoningEffort: 'high' });
});

it('restores the requested model without a catalog and does not switch to the provider’s observed alias', () => {
  const previous = run('gpt-fast', '2026-10-09T10:00:00Z');
  previous.observedSettings = { model: 'resolved-alias', modelProvider: 'openai' };
  expect(initialPreviewAgentSelection([previous], defaults))
    .toEqual({ runtimeId: 'codex', model: 'gpt-fast', modelProvider: 'openai', reasoningEffort: 'high' });
});
