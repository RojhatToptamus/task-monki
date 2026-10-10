import type { Ref } from 'react';
import { Plus, Search } from 'lucide-react';
import type { DiscourseConversationSummary } from '../../shared/discourse';
import { PanelIcon } from './AppNavigation';

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
          aria-label="Dismiss conversation list"
          onClick={onClose}
        />
      ) : null}
      <aside
        id="discourse-history-panel"
        ref={railRef}
        className={`tm-discourse-rail ${modalOpen ? 'tm-discourse-rail--open' : ''}`}
        aria-labelledby="discourse-rail-title"
        aria-modal={modalOpen ? true : undefined}
        role={modalOpen ? 'dialog' : undefined}
        tabIndex={modalOpen ? -1 : undefined}
      >
        <div className="tm-listrail__head">
          <div>
            <h2 id="discourse-rail-title">Discourse</h2>
          </div>
          <div className="tm-listrail__head-actions">
            <button
              type="button"
              className="tm-listrail__new"
              disabled={sending}
              onClick={onNewConversation}
            >
              <PlusIcon />
              <span>New</span>
            </button>
            {modalOpen ? (
              <button
                type="button"
                className="tm-iconbtn tm-discourse-rail__close"
                aria-label="Close conversation list"
                title="Close conversation list"
                onClick={onClose}
              >
                <PanelIcon />
              </button>
            ) : null}
          </div>
        </div>
        <label className="tm-listrail__search">
          <SearchIcon />
          <span className="tm-visually-hidden">Search conversation titles</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search conversations"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
        <div className="segmented segmented--fill tm-listrail__filter" role="group" aria-label="Conversation status">
          <button
            type="button"
            className="segmented__btn"
            aria-pressed={!archived}
            onClick={() => onArchivedChange(false)}
          >
            Recent
          </button>
          <button
            type="button"
            className="segmented__btn"
            aria-pressed={archived}
            onClick={() => onArchivedChange(true)}
          >
            Archive
          </button>
        </div>
        <div className="tm-listrail__list">
          {newConversation && !archived ? (
            <div className="tm-listrail__item tm-listrail__item--active" aria-current="page">
              <span className="tm-listrail__item-title">New conversation</span>
              <span className="tm-listrail__item-meta">Draft</span>
            </div>
          ) : null}
          {conversations.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              disabled={sending}
              className={`tm-listrail__item ${
                conversation.id === selectedConversationId ? 'tm-listrail__item--active' : ''
              }`}
              title={conversation.title}
              aria-current={conversation.id === selectedConversationId ? 'page' : undefined}
              onClick={() => onSelectConversation(conversation.id)}
            >
              <span className="tm-listrail__item-title">{conversation.title}</span>
              <span className="tm-listrail__item-meta">
                {conversation.needsAttention ? (
                  <span data-tone="blocked">Needs attention</span>
                ) : null}
                {conversation.unreadCount > 0 ? (
                  <span
                    className="tm-listrail__count"
                    aria-label={`${conversation.unreadCount} unread`}
                  >
                    {conversation.unreadCount}
                  </span>
                ) : null}
                <time dateTime={conversation.lastMessageAt ?? conversation.updatedAt}>
                  {formatCompactDate(conversation.lastMessageAt ?? conversation.updatedAt)}
                </time>
              </span>
            </button>
          ))}
          {conversations.length === 0 && !newConversation ? (
            <p className="tm-listrail__empty">
              {query ? 'No conversations match' : archived ? 'Archive is empty' : 'No conversations yet'}
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

function PlusIcon() {
  return <Plus aria-hidden="true" size={16} />;
}

function SearchIcon() {
  return <Search aria-hidden="true" size={16} />;
}
