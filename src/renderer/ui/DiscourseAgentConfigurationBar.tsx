import { useId, useRef } from 'react';
import type {
  BuiltInAgentProfileId,
  DiscourseAgentSelectionInput,
  DiscourseConversationAggregateRecord,
  DiscourseDefaultPolicy,
  DiscourseMentionCatalogSnapshot
} from '../../shared/discourse';
import {
  currentDiscourseParticipantRevisions,
  discourseResponderToggleDisabled,
  eligibleDiscourseRuntimeCatalog
} from '../model/discourse';
import { AgentModelSelector } from './AgentModelSelector';
import { useDialogFocusBoundary } from './dialogFocus';

interface DiscourseAgentConfigurationBarProps {
  aggregate?: DiscourseConversationAggregateRecord;
  catalog: DiscourseMentionCatalogSnapshot;
  compact: boolean;
  disabled: boolean;
  expanded: boolean;
  policy: DiscourseDefaultPolicy;
  selections: DiscourseAgentSelectionInput[];
  selectedProfileIds: BuiltInAgentProfileId[];
  onDiscoverModels(runtimeId: string): Promise<void>;
  onExpandedChange(expanded: boolean): void;
  onToggleAgent(profileId: BuiltInAgentProfileId): void;
  onSelectionChange(selection: DiscourseAgentSelectionInput): void;
}

/**
 * Conversation-scoped responder configuration. This owns the relationship
 * between a role, provider, model, and reasoning choice so the workspace does
 * not duplicate catalog-resolution rules in its composer controller.
 */
export function DiscourseAgentConfigurationBar({
  aggregate,
  catalog,
  compact,
  disabled,
  expanded,
  policy,
  selections,
  selectedProfileIds,
  onDiscoverModels,
  onExpandedChange,
  onToggleAgent,
  onSelectionChange
}: DiscourseAgentConfigurationBarProps) {
  const eligible = eligibleDiscourseRuntimeCatalog(catalog);
  const currentRevisions = currentDiscourseParticipantRevisions(aggregate);
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const compactSheetOpen = compact && expanded;
  useDialogFocusBoundary({
    dialogRef,
    initialFocusRef: triggerRef,
    busy: false,
    onClose: () => onExpandedChange(false),
    returnFocus: triggerRef.current,
    active: compactSheetOpen
  });
  return (
    <>
      {compactSheetOpen ? (
        <button
          type="button"
          className="tm-discourse-agent-config-scrim"
          aria-label="Close agent configuration"
          onClick={() => onExpandedChange(false)}
        />
      ) : null}
      <section
        ref={dialogRef}
        className={`tm-discourse-agent-config ${
          expanded ? 'tm-discourse-agent-config--expanded' : ''
        }`}
        aria-labelledby={titleId}
        aria-modal={compactSheetOpen ? true : undefined}
        role={compactSheetOpen ? 'dialog' : undefined}
        tabIndex={compactSheetOpen ? -1 : undefined}
      >
      <header>
        <div>
          <h2 id={titleId}>Responders</h2>
          <div className="tm-discourse-agent-config__summary">
            {selections.map((selection) => {
              const entry = catalog.agents.find(
                (candidate) => candidate.profile.id === selection.agentProfileId
              );
              const model = eligible.models.find(
                (candidate) =>
                  candidate.runtimeId === selection.runtimeId &&
                  candidate.id === selection.modelId
              );
              const currentRevision = currentRevisions.find(
                (revision) =>
                  revision.agentProfileId === selection.agentProfileId &&
                  revision.runtimeId === selection.runtimeId
              );
              const runtime = eligible.runtimes.find(
                (candidate) => candidate.preflight.runtime.id ===
                  (model?.runtimeId ?? currentRevision?.runtimeId ?? selection.runtimeId)
              );
              const modelSummary = model
                ? [runtime?.preflight.runtime.displayName, model.displayName]
                    .filter(Boolean)
                    .join(' · ')
                : currentRevision
                  ? [runtime?.preflight.runtime.displayName, `${currentRevision.model} unavailable`]
                      .filter(Boolean)
                      .join(' · ')
                  : 'Model needed';
              return entry ? (
                <span key={selection.agentProfileId}>
                  {entry.profile.displayName}
                  <small>{modelSummary}</small>
                </span>
              ) : null;
            })}
          </div>
        </div>
        <button
          ref={triggerRef}
          type="button"
          disabled={!expanded && disabled}
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? 'Done' : 'Configure'}
        </button>
      </header>
      {expanded && (policy === 'DIRECT' || policy === 'PANEL') ? (
        <div
          className="tm-discourse-agent-config__roster"
          role="group"
          aria-label="Choose responding agents"
        >
          {catalog.agents.map((entry) => (
            <button
              type="button"
              key={entry.profile.id}
              disabled={discourseResponderToggleDisabled({
                controlsDisabled: disabled,
                policy,
                selectedProfileIds,
                profileId: entry.profile.id,
                available: entry.availability === 'AVAILABLE'
              })}
              aria-pressed={selectedProfileIds.includes(entry.profile.id)}
              onClick={() => onToggleAgent(entry.profile.id)}
            >
              <span aria-hidden="true">{entry.profile.displayName.slice(0, 1)}</span>
              {entry.profile.displayName}
            </button>
          ))}
        </div>
      ) : null}
      {expanded ? (
        <div className="tm-discourse-agent-config__list" aria-label="Responder settings">
          {selections.map((selection) => {
            const entry = catalog.agents.find(
              (candidate) => candidate.profile.id === selection.agentProfileId
            );
            if (!entry) return null;
            const currentRevision = currentRevisions.find(
              (revision) => revision.agentProfileId === selection.agentProfileId
            );
            const selectedModel = eligible.models.find(
              (model) =>
                model.runtimeId === selection.runtimeId && model.id === selection.modelId
            );
            const fallbackSummary = selection.runtimeId
              ? currentRevision?.runtimeId === selection.runtimeId
                ? currentRevision.model
                : 'Choose a model'
              : 'Choose provider and model';
            return (
              <div
                className="tm-discourse-agent-config__agent"
                key={selection.agentProfileId}
              >
                <span className="tm-discourse-agent-config__avatar" aria-hidden="true">
                  {entry.profile.displayName.slice(0, 1)}
                </span>
                <div className="tm-discourse-agent-config__identity">
                  <strong>{entry.profile.displayName}</strong>
                  <small>{capitalize(entry.profile.roleTemplate)}</small>
                </div>
                <AgentModelSelector
                  compact
                  label={`${entry.profile.displayName} provider and model`}
                  runtimeId={selection.runtimeId ?? ''}
                  modelId={selection.modelId ?? ''}
                  reasoningEffort={selection.reasoningEffort}
                  models={eligible.models}
                  runtimes={eligible.runtimes}
                  disabled={disabled}
                  fallbackSummary={fallbackSummary}
                  selectionUnavailable={!selectedModel}
                  showSelectionError={false}
                  onDiscoverModels={onDiscoverModels}
                  onSelectionChange={(runtimeId, modelId) => {
                    const model = eligible.models.find(
                      (candidate) =>
                        candidate.runtimeId === runtimeId && candidate.id === modelId
                    );
                    const reasoningEffort =
                      selection.runtimeId === runtimeId && selection.modelId === modelId
                        ? selection.reasoningEffort
                        : model?.defaultReasoningEffort;
                    onSelectionChange({
                      agentProfileId: selection.agentProfileId,
                      ...(runtimeId ? { runtimeId } : {}),
                      ...(modelId ? { modelId } : {}),
                      ...(reasoningEffort ? { reasoningEffort } : {})
                    });
                  }}
                  onReasoningEffortChange={(reasoningEffort) => {
                    const { reasoningEffort: _current, ...base } = selection;
                    onSelectionChange({
                      ...base,
                      ...(reasoningEffort ? { reasoningEffort } : {})
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
      ) : null}
      {expanded ? (
        <p className="tm-discourse-agent-config__note">
          {configurationNote(policy)} Changes apply to the next response in this conversation.
        </p>
      ) : null}
      </section>
    </>
  );
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`;
}

function configurationNote(policy: DiscourseDefaultPolicy): string {
  switch (policy) {
    case 'DIRECT': return 'Choose one responder.';
    case 'PANEL': return 'Choose two or three independent responders.';
    case 'TEAM': return 'Lead answers, then Skeptic and Verifier review before any correction.';
    case 'NONE': return '';
  }
}
