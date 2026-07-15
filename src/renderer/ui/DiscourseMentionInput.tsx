import {
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent
} from 'react';
import {
  canRedoDiscourseMentionSelection,
  canUndoDiscourseMentionSelection,
  createDiscourseComposerMentionState,
  DEFAULT_DISCOURSE_MENTION_SELECTION_MODE,
  findDiscourseMentionQuery,
  moveDiscourseMentionActiveOption,
  rankDiscourseMentionCandidates,
  redoDiscourseMentionSelection,
  removeDiscourseComposerToken,
  selectDiscourseMention,
  setDiscourseComposerComposition,
  undoDiscourseMentionSelection,
  updateDiscourseComposerText,
  type DiscourseComposerMentionState,
  type DiscourseComposerToken,
  type DiscourseMentionCandidate,
  type DiscourseMentionKind,
  type DiscourseMentionSelectionMode
} from '../model/discourseMentions';

export interface DiscourseMentionInputProps {
  candidates: readonly DiscourseMentionCandidate[];
  initialText?: string;
  initialTokens?: readonly DiscourseComposerToken[];
  selectionMode?: DiscourseMentionSelectionMode;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange?(state: DiscourseComposerMentionState): void;
  onSubmit?(state: DiscourseComposerMentionState): void;
}

/**
 * Phase-1 accessibility prototype and the intended shipping DOM seam: the
 * multiline editable combobox retains focus while a separate grouped listbox
 * exposes active-descendant navigation. Structured tokens remain outside the
 * plain-text textarea.
 */
export function DiscourseMentionInput({
  candidates,
  initialText = '',
  initialTokens = [],
  selectionMode = DEFAULT_DISCOURSE_MENTION_SELECTION_MODE,
  label = 'Message',
  placeholder = 'Ask a question or add a note…',
  disabled,
  autoFocus,
  onChange,
  onSubmit
}: DiscourseMentionInputProps) {
  const [state, setState] = useState(() => ({
    ...createDiscourseComposerMentionState(initialText),
    tokens: [...initialTokens]
  }));
  const [activeId, setActiveId] = useState<string>();
  const [dismissedQuery, setDismissedQuery] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const instanceId = useId().replace(/:/gu, '');
  const listboxId = `discourse-mentions-${instanceId}`;
  const query = findDiscourseMentionQuery(state);
  const queryFingerprint = query
    ? `${state.text}\u0000${state.selectionStart}\u0000${query.start}`
    : undefined;
  const results = useMemo(
    () => (query ? rankDiscourseMentionCandidates(candidates, query.query) : []),
    [candidates, query]
  );
  const open = Boolean(query && dismissedQuery !== queryFingerprint);
  const availableOptionIds = results
    .filter((candidate) => candidate.available)
    .map((candidate) => candidate.id);
  const effectiveActiveId =
    activeId && availableOptionIds.includes(activeId) ? activeId : undefined;

  const commit = (next: DiscourseComposerMentionState) => {
    setState(next);
    onChange?.(next);
  };

  const restoreFocus = (next: DiscourseComposerMentionState) => {
    queueMicrotask(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  };

  const choose = (candidate: DiscourseMentionCandidate) => {
    if (!query || !candidate.available) return;
    const next = selectDiscourseMention(state, query, candidate, selectionMode);
    commit(next);
    setActiveId(undefined);
    setDismissedQuery(undefined);
    restoreFocus(next);
  };

  const updateFromTextarea = (textarea: HTMLTextAreaElement) => {
    const next = updateDiscourseComposerText(state, {
      text: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd
    });
    commit(next);
    setActiveId(undefined);
    setDismissedQuery(undefined);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && query) {
      if (
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'Home' ||
        event.key === 'End'
      ) {
        event.preventDefault();
        setActiveId(
          moveDiscourseMentionActiveOption({
            optionIds: availableOptionIds,
            activeId: effectiveActiveId,
            key: event.key
          })
        );
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && effectiveActiveId) {
        const candidate = results.find((result) => result.id === effectiveActiveId);
        if (candidate) {
          event.preventDefault();
          choose(candidate);
        }
        return;
      }
      if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        setDismissedQuery(queryFingerprint);
        setActiveId(undefined);
        return;
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSubmit) {
      event.preventDefault();
      onSubmit(state);
      return;
    }
    if (
      event.key === 'Backspace' &&
      state.text.length === 0 &&
      state.tokens.length > 0
    ) {
      event.preventDefault();
      document.getElementById(tokenButtonId(instanceId, state.tokens.at(-1)!.key))?.focus();
    }
  };

  const handleBeforeInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const inputType = (event.nativeEvent as InputEvent).inputType;
    if (inputType === 'historyUndo' && canUndoDiscourseMentionSelection(state)) {
      event.preventDefault();
      const next = undoDiscourseMentionSelection(state);
      commit(next);
      restoreFocus(next);
    } else if (inputType === 'historyRedo' && canRedoDiscourseMentionSelection(state)) {
      event.preventDefault();
      const next = redoDiscourseMentionSelection(state);
      commit(next);
      restoreFocus(next);
    }
  };

  const removeToken = (tokenKey: string) => {
    const next = removeDiscourseComposerToken(state, tokenKey);
    commit(next);
    restoreFocus(next);
  };

  const preserveTextareaFocus = (event: MouseEvent) => event.preventDefault();

  return (
    <div className="discourse-mention-input">
      <MentionTokenGroup
        kind="AGENT"
        label="Ask"
        state={state}
        instanceId={instanceId}
        onRemove={removeToken}
      />
      <MentionTokenGroup
        kind="CONTEXT"
        label="Context"
        state={state}
        instanceId={instanceId}
        onRemove={removeToken}
      />

      <label className="discourse-mention-input__label" htmlFor={`discourse-textarea-${instanceId}`}>
        {label}
      </label>
      <textarea
        ref={textareaRef}
        id={`discourse-textarea-${instanceId}`}
        className="discourse-mention-input__textarea"
        role="combobox"
        aria-multiline="true"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open && effectiveActiveId
            ? mentionOptionId(instanceId, effectiveActiveId)
            : undefined
        }
        value={state.text}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => updateFromTextarea(event.currentTarget)}
        onSelect={(event) => {
          const textarea = event.currentTarget;
          if (
            textarea.selectionStart !== state.selectionStart ||
            textarea.selectionEnd !== state.selectionEnd
          ) {
            commit({
              ...state,
              selectionStart: textarea.selectionStart,
              selectionEnd: textarea.selectionEnd
            });
          }
        }}
        onBeforeInput={handleBeforeInput}
        onCompositionStart={() => {
          commit(setDiscourseComposerComposition(state, true));
          setActiveId(undefined);
        }}
        onCompositionEnd={(event) => {
          const composed = setDiscourseComposerComposition(state, false);
          const next = updateDiscourseComposerText(composed, {
            text: event.currentTarget.value,
            selectionStart: event.currentTarget.selectionStart,
            selectionEnd: event.currentTarget.selectionEnd
          });
          commit(next);
          setDismissedQuery(undefined);
        }}
        onKeyDown={handleKeyDown}
      />

      <div
        id={listboxId}
        className="discourse-mention-input__listbox"
        role="listbox"
        aria-label="Mention agents, tasks, or repositories"
        hidden={!open}
        onMouseDown={preserveTextareaFocus}
      >
        {(['AGENT', 'TASK', 'REPOSITORY'] as const).map((kind) => {
          const group = results.filter((candidate) => candidate.kind === kind);
          if (group.length === 0) return null;
          return (
            <div role="group" aria-label={mentionKindLabel(kind)} key={kind}>
              <div className="discourse-mention-input__group-label" aria-hidden="true">
                {mentionKindLabel(kind)}
              </div>
              {group.map((candidate) => (
                <div
                  id={mentionOptionId(instanceId, candidate.id)}
                  role="option"
                  aria-selected={candidate.id === effectiveActiveId}
                  aria-disabled={!candidate.available}
                  className="discourse-mention-input__option"
                  key={`${candidate.kind}:${candidate.id}`}
                  onClick={() => choose(candidate)}
                >
                  <strong>{candidate.label}</strong>
                  <span>{candidate.description}</span>
                  {!candidate.available ? <span>Unavailable</span> : null}
                </div>
              ))}
            </div>
          );
        })}
        {results.length === 0 ? (
          <div className="discourse-mention-input__empty">No matching results</div>
        ) : null}
      </div>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {state.announcement}
      </div>
    </div>
  );
}

function MentionTokenGroup({
  kind,
  label,
  state,
  instanceId,
  onRemove
}: {
  kind: 'AGENT' | 'CONTEXT';
  label: string;
  state: DiscourseComposerMentionState;
  instanceId: string;
  onRemove(tokenKey: string): void;
}) {
  const tokens = state.tokens.filter((token) =>
    kind === 'AGENT' ? token.kind === 'AGENT' : token.kind !== 'AGENT'
  );
  if (tokens.length === 0) return null;
  return (
    <div className="discourse-mention-input__tokens" aria-label={`${label} selections`}>
      <span>{label}</span>
      <ul>
        {tokens.map((token) => (
          <li key={token.key}>
            <button
              id={tokenButtonId(instanceId, token.key)}
              type="button"
              aria-label={`Remove ${token.labelSnapshot} from ${label}`}
              onClick={() => onRemove(token.key)}
              onKeyDown={(event) => {
                if (event.key === 'Backspace' || event.key === 'Delete') {
                  event.preventDefault();
                  onRemove(token.key);
                }
              }}
            >
              {token.labelSnapshot}
              <span aria-hidden="true">×</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function mentionOptionId(instanceId: string, candidateId: string): string {
  return `discourse-option-${instanceId}-${domSafeId(candidateId)}`;
}

function tokenButtonId(instanceId: string, tokenKey: string): string {
  return `discourse-token-${instanceId}-${domSafeId(tokenKey)}`;
}

function domSafeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '-');
}

function mentionKindLabel(kind: DiscourseMentionKind): string {
  return kind === 'AGENT' ? 'Agents' : kind === 'TASK' ? 'Tasks' : 'Repositories';
}
