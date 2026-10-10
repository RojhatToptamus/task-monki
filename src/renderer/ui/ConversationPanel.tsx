import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, X } from 'lucide-react';
import { Conversation, useConversationScroll } from './Conversation';
import { useDialogFocusBoundary } from './dialogFocus';
import { StatusGlyph } from './StatusBadge';

export interface ConversationPanelComposer {
  placeholder: string;
  /** One line beside the send control: what sending does, or why it is unavailable. */
  hint: string;
  disabled?: boolean;
  /** The agent is working; the field stays open because a message can wait its turn. */
  busy?: boolean;
  /** What the send control does: "Send" now, "Queue" behind the current response. */
  sendLabel?: string;
  /** The unsent text, owned by the caller so it survives closing the panel. */
  draft: string;
  onDraftChange(text: string): void;
  onSubmit(text: string): Promise<void>;
  /** One outline action beside send, such as Stop. */
  secondary?: { label: string; title?: string; disabled?: boolean; onClick(): Promise<void> };
  /** A strip above the field, such as the queue or an editing notice. */
  above?: ReactNode;
}

/**
 * A conversation beside a working surface: a 44px head, the shared conversation log, and the
 * shared composer. Escape closes it and focus returns to whatever opened it. The caller owns
 * the thread and what sending means.
 */
export function ConversationPanel({ title, tools, label, onClose, composer, children }: {
  title: string;
  /** Controls below the input, such as the model selector. */
  tools?: ReactNode;
  label: string;
  onClose(): void;
  composer: ConversationPanelComposer;
  children: ReactNode;
}) {
  const fieldId = useId();
  const hintId = useId();
  const root = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const { draft, onDraftChange } = composer;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const scroller = useConversationScroll();
  useDialogFocusBoundary({ dialogRef: root, initialFocusRef: field, trapFocus: false, busy: false, onClose });
  const canSend = !composer.disabled && !sending && draft.trim().length > 0;
  async function submit() {
    if (!canSend) return;
    const text = draft.trim();
    setSending(true);
    setError(undefined);
    try {
      await composer.onSubmit(text);
      onDraftChange('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The message could not be sent.');
    } finally {
      setSending(false);
      field.current?.focus();
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  };
  const sendLabel = composer.sendLabel ?? 'Send';
  return (
    <aside ref={root} className="tm-side-conversation" aria-label={label} tabIndex={-1}>
      <header className="tm-side-conversation__head">
        <strong>{title}</strong>
        <button type="button" className="tm-iconbtn" aria-label={`Close ${title}`} title="Close · Esc" onClick={onClose}>
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>
      <Conversation instance={scroller} label={label} className="tm-side-conversation__log">
        <div className="tm-side-conversation__thread">{children}</div>
      </Conversation>
      <form
        className="tm-composer tm-side-conversation__composer"
        aria-busy={sending}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {composer.above}
        <label className="tm-visually-hidden" htmlFor={fieldId}>{composer.placeholder}</label>
        <textarea
          ref={field}
          id={fieldId}
          className="tm-composer__input"
          rows={2}
          value={draft}
          placeholder={composer.placeholder}
          disabled={composer.disabled}
          readOnly={sending}
          aria-describedby={error || composer.hint ? hintId : undefined}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="tm-composer__toolbar">
          {tools ? <div className="tm-side-conversation__tools">{tools}</div> : null}
          {error || composer.hint ? <span id={hintId} className="tm-composer__hint" title={error ?? composer.hint}>{error ?? composer.hint}</span> : null}
          {composer.secondary ? (
            <button type="button" className="outline-button tm-composer__secondary" disabled={composer.secondary.disabled || sending} title={composer.secondary.title}
              onClick={() => void composer.secondary!.onClick().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}>
              {composer.secondary.label}
            </button>
          ) : null}
          <button type="submit" className="primary-button tm-composer-action" disabled={!canSend} aria-label={sendLabel} title={`${sendLabel} · ⌘/Ctrl Enter`}>
            {sending ? <StatusGlyph kind="working" /> : <ArrowUp size={16} strokeWidth={1.5} aria-hidden="true" />}
          </button>
        </div>
        {error ? <p className="tm-visually-hidden" role="alert">{error}</p> : null}
      </form>
    </aside>
  );
}
