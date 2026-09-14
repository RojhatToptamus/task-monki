import type {
  BuiltInAgentProfileId, DiscourseAgentSelectionInput, DiscourseConversationAggregateRecord,
  DiscourseMentionCatalogSnapshot
} from '../../shared/discourse';
import {
  currentDiscourseParticipantRevisions, eligibleDiscourseRuntimeCatalog
} from '../model/discourse';
import { runtimeExecutionUnavailableReason } from '../model/runtimeReadiness';
import { AgentModelSelector } from './AgentModelSelector';

interface DiscourseAgentSettingsProps {
  aggregate?: DiscourseConversationAggregateRecord;
  catalog: DiscourseMentionCatalogSnapshot;
  disabled: boolean;
  selections: DiscourseAgentSelectionInput[];
  selectedProfileIds: BuiltInAgentProfileId[];
  onDiscoverModels(runtimeId: string): Promise<void>;
  onToggleAgent(profileId: BuiltInAgentProfileId): void;
  onSelectionChange(selection: DiscourseAgentSelectionInput): void;
}

/** Responder controls inside the workspace sidebar, using the shared model picker. */
export function DiscourseAgentSettings({
  aggregate, catalog, disabled, selections, selectedProfileIds,
  onDiscoverModels, onToggleAgent, onSelectionChange
}: DiscourseAgentSettingsProps) {
  const eligible = eligibleDiscourseRuntimeCatalog(catalog);
  const currentRevisions = currentDiscourseParticipantRevisions(aggregate);
  return (
    <section className="tm-discourse-agent-config" aria-label="Agent settings">
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
                <strong>{index === 0 ? 'Main agent' : 'Peer'}</strong>
                <small>{entry.profile.displayName}</small>
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
      <button type="button" className="outline-button" disabled={disabled}
        onClick={() => onToggleAgent(selectedProfileIds[0] ?? 'builtin.lead')}>
        {selections.length > 1 ? 'Remove peer' : 'Add peer'}
      </button>
    </section>
  );
}
