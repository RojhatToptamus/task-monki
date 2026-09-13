import type {
  BuiltInAgentProfileId, DiscourseAgentSelectionInput, DiscourseConversationAggregateRecord,
  DiscourseDefaultPolicy, DiscourseMentionCatalogSnapshot
} from '../../shared/discourse';
import {
  currentDiscourseParticipantRevisions, discourseResponderToggleDisabled, eligibleDiscourseRuntimeCatalog
} from '../model/discourse';
import { runtimeExecutionUnavailableReason } from '../model/runtimeReadiness';
import { AgentModelSelector } from './AgentModelSelector';
import { DiscourseCheckIcon } from './DiscourseIcons';

interface DiscourseAgentConfigurationBarProps {
  aggregate?: DiscourseConversationAggregateRecord;
  catalog: DiscourseMentionCatalogSnapshot;
  disabled: boolean;
  policy: DiscourseDefaultPolicy;
  selections: DiscourseAgentSelectionInput[];
  selectedProfileIds: BuiltInAgentProfileId[];
  onDiscoverModels(runtimeId: string): Promise<void>;
  onToggleAgent(profileId: BuiltInAgentProfileId): void;
  onSelectionChange(selection: DiscourseAgentSelectionInput): void;
}

/** Responder controls inside the workspace sidebar, using the shared model picker. */
export function DiscourseAgentConfigurationBar({
  aggregate, catalog, disabled, policy, selections, selectedProfileIds,
  onDiscoverModels, onToggleAgent, onSelectionChange
}: DiscourseAgentConfigurationBarProps) {
  const eligible = eligibleDiscourseRuntimeCatalog(catalog);
  const currentRevisions = currentDiscourseParticipantRevisions(aggregate);
  return (
    <section className="tm-discourse-agent-config" aria-label="Agent settings">
      {(policy === 'DIRECT' || policy === 'PANEL') ? (
        <div className="tm-discourse-agent-config__roster" role="group" aria-label="Choose responding agents">
          {catalog.agents.map((entry) => (
            <button type="button" key={entry.profile.id}
              disabled={discourseResponderToggleDisabled({ controlsDisabled: disabled, policy,
                selectedProfileIds, profileId: entry.profile.id, available: entry.availability === 'AVAILABLE' })}
              aria-pressed={selectedProfileIds.includes(entry.profile.id)}
              onClick={() => onToggleAgent(entry.profile.id)}>
              {entry.profile.displayName}
              <span className="tm-discourse-agent-config__roster-check" aria-hidden="true">
                {selectedProfileIds.includes(entry.profile.id) ? <DiscourseCheckIcon /> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="tm-discourse-agent-config__list" aria-label="Responder settings">
        {selections.map((selection, index) => {
          const entry = catalog.agents.find((candidate) => candidate.profile.id === selection.agentProfileId);
          if (!entry) return null;
          const currentRevision = currentRevisions.find((revision) => revision.agentProfileId === selection.agentProfileId);
          const selectedModel = eligible.models.find((model) => model.runtimeId === selection.runtimeId && model.id === selection.modelId);
          const fallbackSummary = selection.modelId ??
            (currentRevision?.runtimeId === selection.runtimeId ? currentRevision?.model : undefined) ??
            'Choose provider and model';
          return (
            <div className="tm-discourse-agent-config__agent" key={selection.agentProfileId}>
              <div className="tm-discourse-agent-config__identity">
                <strong>{entry.profile.displayName}</strong>
                {policy === 'TEAM' ? <small>{index === 2 ? 'Comparison' : 'Independent answer'}</small> : null}
              </div>
              <AgentModelSelector
                presentation="compact"
                label={entry.profile.displayName + ' provider and model'}
                runtimeId={selection.runtimeId ?? ''}
                modelId={selection.modelId ?? ''}
                reasoningEffort={selection.reasoningEffort}
                models={catalog.runtimeCatalog.models}
                runtimes={catalog.runtimeCatalog.runtimes}
                runtimeUnavailableReason={(runtime) => runtimeExecutionUnavailableReason(runtime, 'DISCOURSE')}
                disabled={disabled}
                fallbackSummary={fallbackSummary}
                selectionUnavailable={!selectedModel}
                showSelectionError
                onDiscoverModels={onDiscoverModels}
                onSelectionChange={(runtimeId, modelId) => {
                  const model = eligible.models.find((candidate) => candidate.runtimeId === runtimeId && candidate.id === modelId);
                  const reasoningEffort = selection.runtimeId === runtimeId && selection.modelId === modelId
                    ? selection.reasoningEffort : model?.defaultReasoningEffort;
                  onSelectionChange({ agentProfileId: selection.agentProfileId,
                    ...(runtimeId ? { runtimeId } : {}), ...(modelId ? { modelId } : {}),
                    ...(reasoningEffort ? { reasoningEffort } : {}) });
                }}
                onReasoningEffortChange={(reasoningEffort) => {
                  const { reasoningEffort: _current, ...base } = selection;
                  onSelectionChange({ ...base, ...(reasoningEffort ? { reasoningEffort } : {}) });
                }}
              />
            </div>
          );
        })}
      </div>
      <p className="tm-discourse-agent-config__note">Changes apply to the next response and new conversations.</p>
    </section>
  );
}
