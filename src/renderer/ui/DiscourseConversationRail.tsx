import type { Ref } from 'react';
import type { DiscourseConversationSummary } from '../../shared/discourse';

interface DiscourseConversationRailProps {
  archived: boolean;
  conversations: readonly DiscourseConversationSummary[];
  modalOpen: boolean;
  newConversation: boolean;
  query: string;
  railRef: Ref<HTMLElement>;
  searchRef: Ref<HTMLInputElement>;
  selectedConversationId?: string;
  sending: boolean;
  onArchivedChange(archived: boolean): void;
  onClose(): void;
  onNewConversation(): void;
  onQueryChange(query: string): void;
  onSelectConversation(conversationId: string): void;
}

/** Conversation navigation owns only rail presentation and selection events. */
export function DiscourseConversationRail({
  archived,
  conversations,
  modalOpen,
  newConversation,
  query,
  railRef,
  searchRef,
  selectedConversationId,
  sending,
  onArchivedChange,
  onClose,
  onNewConversation,
  onQueryChange,
  onSelectConversation
}: DiscourseConversationRailProps) {
  return (
    <>
      {modalOpen ? (
        <button
          type="button"
          className="tm-discourse-drawer-scrim tm-discourse-drawer-scrim--rail"
          aria-label="Close conversations"
          onClick={onClose}
        />
      ) : null}
      <aside
        ref={railRef}
        className={`tm-discourse-rail ${modalOpen ? 'tm-discourse-rail--open' : ''}`}
        aria-label="Discourse conversations"
        aria-modal={modalOpen ? true : undefined}
        role={modalOpen ? 'dialog' : undefined}
        tabIndex={modalOpen ? -1 : undefined}
      >
        <div className="tm-discourse-rail__head">
          <div>
            <h1>Discourse</h1>
            <p>Technical conversations across tasks and repositories</p>
          </div>
          <button
            type="button"
            className="tm-discourse-new"
            disabled={sending}
            onClick={onNewConversation}
          >
            <PlusIcon />
            <span>New</span>
          </button>
        </div>
        <label className="tm-discourse-search">
          <SearchIcon />
          <span className="tm-visually-hidden">Search conversation titles</span>
          <input
            ref={searchRef}
            value={query}
            placeholder="Search conversations"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
        <div className="tm-discourse-rail__filter" role="group" aria-label="Conversation status">
          <button
            type="button"
            aria-pressed={!archived}
            onClick={() => onArchivedChange(false)}
          >
            Recent
          </button>
          <button
            type="button"
            aria-pressed={archived}
            onClick={() => onArchivedChange(true)}
          >
            Archive
          </button>
        </div>
        <div className="tm-discourse-rail__list">
          {newConversation && !archived ? (
            <div className="tm-discourse-thread tm-discourse-thread--active" aria-current="page">
              <span className="tm-discourse-thread__title">New conversation</span>
              <small>Draft</small>
            </div>
          ) : null}
          {conversations.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              disabled={sending}
              className={`tm-discourse-thread ${
                conversation.id === selectedConversationId ? 'tm-discourse-thread--active' : ''
              }`}
              aria-current={conversation.id === selectedConversationId ? 'page' : undefined}
              onClick={() => onSelectConversation(conversation.id)}
            >
              <span className="tm-discourse-thread__title">{conversation.title}</span>
              <span className="tm-discourse-thread__meta">
                {conversation.needsAttention ? (
                  <span className="tm-discourse-attention">Needs attention</span>
                ) : null}
                {conversation.unreadCount > 0 ? (
                  <span
                    className="tm-discourse-unread"
                    aria-label={`${conversation.unreadCount} unread`}
                  >
                    {conversation.unreadCount}
                  </span>
                ) : (
                  <time>{formatCompactDate(conversation.lastMessageAt ?? conversation.updatedAt)}</time>
                )}
              </span>
            </button>
          ))}
          {conversations.length === 0 && !newConversation ? (
            <p className="tm-discourse-rail__empty">
              {query
                ? 'No titles match your search.'
                : archived
                  ? 'No archived conversations.'
                  : 'No conversations yet.'}
            </p>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function formatCompactDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

const ICON = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
};

function PlusIcon() {
  return <svg {...ICON}><path d="M12 5v14M5 12h14" /></svg>;
}

function SearchIcon() {
  return <svg {...ICON}><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>;
}
