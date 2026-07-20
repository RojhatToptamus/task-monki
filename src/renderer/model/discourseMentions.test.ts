import { describe, expect, it } from 'vitest';
import {
  canRedoDiscourseMentionSelection,
  canUndoDiscourseMentionSelection,
  createDiscourseComposerMentionState,
  DEFAULT_DISCOURSE_MENTION_SELECTION_MODE,
  findDiscourseMentionQuery,
  lastRenderedDiscourseComposerToken,
  moveDiscourseMentionActiveOption,
  rankDiscourseMentionCandidates,
  redoDiscourseMentionSelection,
  removeDiscourseComposerToken,
  selectDiscourseMention,
  setDiscourseComposerComposition,
  undoDiscourseMentionSelection,
  updateDiscourseComposerText,
  type DiscourseMentionCandidate
} from './discourseMentions';

const agent: DiscourseMentionCandidate = {
  kind: 'AGENT',
  id: 'builtin.verifier',
  label: 'Verifier',
  description: 'Checks claims against evidence',
  searchAliases: ['fact checker'],
  available: true
};

describe('discourse mention composer model', () => {
  it('targets the last visible token when agent chips are represented elsewhere', () => {
    const state = {
      ...createDiscourseComposerMentionState(),
      tokens: [
        { key: 'TASK:1', kind: 'TASK' as const, entityId: '1', labelSnapshot: 'Task', available: true },
        { key: 'AGENT:lead', kind: 'AGENT' as const, entityId: 'lead', labelSnapshot: 'Lead', available: true }
      ]
    };
    expect(lastRenderedDiscourseComposerToken(state, false)?.key).toBe('TASK:1');
    expect(lastRenderedDiscourseComposerToken({
      ...state,
      tokens: [state.tokens[1]!]
    }, false)).toBeUndefined();
    expect(lastRenderedDiscourseComposerToken(state, true)?.key).toBe('AGENT:lead');
  });

  it('ships the token-only fallback until inline labels pass the rendered AT gate', () => {
    expect(DEFAULT_DISCOURSE_MENTION_SELECTION_MODE).toBe('TOKEN_ONLY');
  });

  it('opens only at a token boundary and ignores email-like text', () => {
    expect(queryAt('Ask @ver')).toMatchObject({ start: 4, end: 8, query: 'ver' });
    expect(queryAt('@')).toMatchObject({ start: 0, query: '' });
    expect(queryAt('mail@example')).toBeUndefined();
    expect(queryAt('Ask (@repo name')).toMatchObject({ query: 'repo name' });
    expect(queryAt('Ask @repo, then')).toBeUndefined();
  });

  it('does not open or select while an IME composition is active', () => {
    const state = setDiscourseComposerComposition(
      updateDiscourseComposerText(createDiscourseComposerMentionState(), {
        text: 'Ask @検',
        selectionStart: 6,
        selectionEnd: 6
      }),
      true
    );
    expect(
      findDiscourseMentionQuery({
        text: state.text,
        selectionStart: state.selectionStart,
        selectionEnd: state.selectionEnd,
        composing: state.composing
      })
    ).toBeUndefined();
    expect(() =>
      selectDiscourseMention(state, { start: 4, end: 6, query: '検' }, agent, 'INLINE_LABEL')
    ).toThrow('during text composition');
  });

  it('adds a readable label and authoritative token as one undoable transaction', () => {
    const initial = updateDiscourseComposerText(createDiscourseComposerMentionState(), {
      text: 'Ask @ver',
      selectionStart: 8,
      selectionEnd: 8
    });
    const selected = selectDiscourseMention(initial, queryAt(initial.text)!, agent, 'INLINE_LABEL');

    expect(selected).toMatchObject({
      text: 'Ask @Verifier ',
      selectionStart: 14,
      announcement: 'Verifier added to Ask.'
    });
    expect(selected.tokens).toEqual([
      expect.objectContaining({ kind: 'AGENT', entityId: 'builtin.verifier' })
    ]);
    expect(canUndoDiscourseMentionSelection(selected)).toBe(true);

    const undone = undoDiscourseMentionSelection(selected);
    expect(undone).toMatchObject({ text: 'Ask @ver', selectionStart: 8, tokens: [] });
    expect(canRedoDiscourseMentionSelection(undone)).toBe(true);
    expect(redoDiscourseMentionSelection(undone)).toMatchObject({
      text: 'Ask @Verifier ',
      tokens: [expect.objectContaining({ entityId: 'builtin.verifier' })]
    });
  });

  it('moves a tray-only selection out of the message without leaving the trigger behind', () => {
    const initial = updateDiscourseComposerText(createDiscourseComposerMentionState(), {
      text: 'Ask @ver about this',
      selectionStart: 8,
      selectionEnd: 8
    });
    const selected = selectDiscourseMention(initial, queryAt('Ask @ver')!, agent, 'TOKEN_ONLY');

    expect(selected.text).toBe('Ask about this');
    expect(selected.selectionStart).toBe(4);
    expect(selected.tokens).toHaveLength(1);
    expect(undoDiscourseMentionSelection(selected)).toMatchObject({
      text: initial.text,
      tokens: []
    });
  });

  it('leaves native text undo in control after the inline label is edited', () => {
    const initial = updateDiscourseComposerText(createDiscourseComposerMentionState(), {
      text: '@ver',
      selectionStart: 4,
      selectionEnd: 4
    });
    const selected = selectDiscourseMention(initial, queryAt(initial.text)!, agent, 'INLINE_LABEL');
    const edited = updateDiscourseComposerText(selected, {
      text: '@Verifier please',
      selectionStart: 16,
      selectionEnd: 16
    });

    expect(canUndoDiscourseMentionSelection(edited)).toBe(false);
    expect(undoDiscourseMentionSelection(edited)).toBe(edited);
  });

  it('does not infer token removal from edited labels or rewrite prose on removal', () => {
    const selected = selectDiscourseMention(
      updateDiscourseComposerText(createDiscourseComposerMentionState(), {
        text: '@ver',
        selectionStart: 4,
        selectionEnd: 4
      }),
      queryAt('@ver')!,
      agent,
      'INLINE_LABEL'
    );
    const edited = updateDiscourseComposerText(selected, {
      text: 'Verifier should check this',
      selectionStart: 26,
      selectionEnd: 26
    });
    expect(edited.tokens).toHaveLength(1);

    const removed = removeDiscourseComposerToken(edited, 'AGENT:builtin.verifier');
    expect(removed.text).toBe(edited.text);
    expect(removed.tokens).toEqual([]);
    expect(removed.announcement).toContain('removed from Ask');
  });

  it('deduplicates authority tokens while preserving a second readable reference', () => {
    const first = selectDiscourseMention(
      updateDiscourseComposerText(createDiscourseComposerMentionState(), {
        text: '@ver', selectionStart: 4, selectionEnd: 4
      }),
      queryAt('@ver')!,
      agent,
      'INLINE_LABEL'
    );
    const secondText = `${first.text}and @ver`;
    const secondBase = updateDiscourseComposerText(first, {
      text: secondText,
      selectionStart: secondText.length,
      selectionEnd: secondText.length
    });
    const second = selectDiscourseMention(
      secondBase,
      queryAt(secondText)!,
      agent,
      'INLINE_LABEL'
    );
    expect(second.tokens).toHaveLength(1);
    expect(second.text.match(/@Verifier/gu)).toHaveLength(2);
  });

  it('sanitizes control and bidi characters in readable labels', () => {
    const selected = selectDiscourseMention(
      updateDiscourseComposerText(createDiscourseComposerMentionState(), {
        text: '@x', selectionStart: 2, selectionEnd: 2
      }),
      queryAt('@x')!,
      { ...agent, id: 'safe-id', label: 'Safe\u202e\nLabel' },
      'INLINE_LABEL'
    );
    expect(selected.text).toBe('@Safe Label ');
    expect(selected.tokens[0]?.labelSnapshot).toBe('Safe Label');
  });

  it('ranks deterministically with repositories ahead of task-heavy context', () => {
    const candidates: DiscourseMentionCandidate[] = [
      { kind: 'REPOSITORY', id: 'repo-1', label: 'Verifier tools', description: '', searchAliases: ['/repo/verifier'], available: true },
      { kind: 'TASK', id: 'task-1', label: 'Verify checkout', description: '', searchAliases: ['TM-1'], available: true },
      { ...agent, recentOrdinal: 4 },
      { kind: 'AGENT', id: 'builtin.skeptic', label: 'Skeptic', description: '', searchAliases: ['reviewer'], available: false }
    ];
    expect(rankDiscourseMentionCandidates(candidates, 'ver').map((item) => item.id)).toEqual([
      'builtin.verifier',
      'builtin.skeptic',
      'repo-1',
      'task-1'
    ]);
    expect(rankDiscourseMentionCandidates(candidates, '').map((item) => item.id)).toEqual([
      'builtin.verifier',
      'builtin.skeptic',
      'repo-1',
      'task-1'
    ]);
  });

  it('retains duplicate display names for explicit ID-based selection', () => {
    const duplicates: DiscourseMentionCandidate[] = [
      { kind: 'TASK', id: 'task-a', label: 'Fix login', description: 'repo-a', searchAliases: [], available: true },
      { kind: 'TASK', id: 'task-b', label: 'Fix login', description: 'repo-b', searchAliases: [], available: true }
    ];
    expect(rankDiscourseMentionCandidates(duplicates, 'Fix login').map((item) => item.id)).toEqual([
      'task-a',
      'task-b'
    ]);
  });

  it('reserves results for every matching kind in a task-heavy workspace', () => {
    const tasks: DiscourseMentionCandidate[] = Array.from({ length: 90 }, (_, index) => ({
      kind: 'TASK',
      id: `task-${index}`,
      label: `Repository task ${index}`,
      description: '',
      searchAliases: ['repository'],
      available: true
    }));
    const candidates: DiscourseMentionCandidate[] = [
      agent,
      ...tasks,
      {
        kind: 'REPOSITORY',
        id: 'repository-1',
        label: 'Task Monki repository',
        description: '',
        searchAliases: ['repository'],
        available: true
      }
    ];

    const results = rankDiscourseMentionCandidates(candidates, 'repository');
    expect(results).toHaveLength(60);
    expect(results[0]).toMatchObject({ kind: 'REPOSITORY', id: 'repository-1' });
    expect(results.some((candidate) => candidate.kind === 'AGENT')).toBe(false);
  });

  it('keeps unavailable results visible but refuses selection', () => {
    const unavailable = { ...agent, available: false };
    expect(rankDiscourseMentionCandidates([unavailable], 'ver')).toEqual([unavailable]);
    expect(() =>
      selectDiscourseMention(
        updateDiscourseComposerText(createDiscourseComposerMentionState(), {
          text: '@ver', selectionStart: 4, selectionEnd: 4
        }),
        queryAt('@ver')!,
        unavailable,
        'TOKEN_ONLY'
      )
    ).toThrow('Unavailable');
  });

  it('implements wrapping arrow navigation and Home/End', () => {
    const optionIds = ['one', 'two', 'three'];
    expect(moveDiscourseMentionActiveOption({ optionIds, key: 'ArrowDown' })).toBe('one');
    expect(moveDiscourseMentionActiveOption({ optionIds, activeId: 'three', key: 'ArrowDown' })).toBe('one');
    expect(moveDiscourseMentionActiveOption({ optionIds, activeId: 'one', key: 'ArrowUp' })).toBe('three');
    expect(moveDiscourseMentionActiveOption({ optionIds, activeId: 'two', key: 'Home' })).toBe('one');
    expect(moveDiscourseMentionActiveOption({ optionIds, activeId: 'two', key: 'End' })).toBe('three');
  });
});

function queryAt(text: string) {
  return findDiscourseMentionQuery({
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
    composing: false
  });
}
