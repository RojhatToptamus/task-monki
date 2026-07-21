import { describe, expect, it } from 'vitest';
import type { DiscourseAgentSelectionInput } from '../../shared/discourse';
import {
  dedupeDiscourseContextSelections,
  dedupeDiscourseMessages,
  deriveDiscourseConversationTitle,
  discoursePendingConversationFingerprint
} from './discourseSend';

describe('Discourse send preparation', () => {
  it('uses the first non-empty line and bounds generated conversation titles', () => {
    expect(deriveDiscourseConversationTitle('\n  A focused title\nMore')).toBe(
      'A focused title'
    );
    const title = deriveDiscourseConversationTitle('x'.repeat(100));
    expect(title).toHaveLength(70);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps pending-create identity stable across agent selection order', () => {
    const selections: DiscourseAgentSelectionInput[] = [
      { agentProfileId: 'builtin.skeptic', runtimeId: 'codex', modelId: 'b' },
      { agentProfileId: 'builtin.lead', runtimeId: 'codex', modelId: 'a' }
    ];
    expect(
      discoursePendingConversationFingerprint('Title', 'PANEL', selections)
    ).toBe(
      discoursePendingConversationFingerprint('Title', 'PANEL', [
        ...selections
      ].reverse())
    );
  });

  it('deduplicates transcript pages by identity and restores ordinal order', () => {
    const messages = [
      { id: 'two', ordinal: 2 },
      { id: 'one', ordinal: 1 },
      { id: 'two', ordinal: 2, body: 'latest' }
    ] as Parameters<typeof dedupeDiscourseMessages>[0];

    expect(dedupeDiscourseMessages(messages)).toEqual([
      expect.objectContaining({ id: 'one' }),
      expect.objectContaining({ id: 'two', body: 'latest' })
    ]);
  });

  it('keeps the first context selection for each entity identity', () => {
    expect(
      dedupeDiscourseContextSelections([
        { entityKind: 'TASK', entityId: 'one', label: 'first' },
        { entityKind: 'TASK', entityId: 'one', label: 'duplicate' },
        { entityKind: 'REPOSITORY', entityId: 'one', label: 'repository' }
      ])
    ).toEqual([
      { entityKind: 'TASK', entityId: 'one', label: 'first' },
      { entityKind: 'REPOSITORY', entityId: 'one', label: 'repository' }
    ]);
  });
});
