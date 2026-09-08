import { useId, useState, type FormEvent } from 'react';
import {
  AGENT_PROFILE_LIMITS,
  type CustomAgentProfile,
  type SaveAgentProfileRequest
} from '../../shared/agentProfiles';
import { AGENT_PROFILE_STARTERS } from '../model/agentProfileStarters';

export interface AgentProfilesSettingsActions {
  onSaveAgentProfile(input: SaveAgentProfileRequest): Promise<void>;
  onDeleteAgentProfile(profileId: string): Promise<void>;
}

export function AgentProfilesSettings({
  profiles,
  onSaveAgentProfile,
  onDeleteAgentProfile
}: AgentProfilesSettingsActions & {
  profiles: readonly CustomAgentProfile[];
}) {
  const [draft, setDraft] = useState<SaveAgentProfileRequest>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const instructionHelpId = useId();
  const edit = (next: SaveAgentProfileRequest | undefined) => {
    setDraft(next);
    setError(undefined);
    setDeleting(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || busy) return;
    setError(undefined);
    setBusy(true);
    try {
      await onSaveAgentProfile(draft);
      edit(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the profile.');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!draft?.id || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDeleteAgentProfile(draft.id);
      edit(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete the profile.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="tm-settings__pane"
      id="settings-panel-profiles"
      role="tabpanel"
      aria-labelledby="settings-tab-profiles"
    >
      <header className="tm-settings__pane-head">
        <div>
          <h2>Agent profiles</h2>
          <p>Save working instructions for tasks and Designs.</p>
        </div>
        {!draft ? (
          <button
            type="button"
            className="tm-settings__button tm-settings__button--primary"
            disabled={profiles.length >= AGENT_PROFILE_LIMITS.maxProfiles}
            title={
              profiles.length >= AGENT_PROFILE_LIMITS.maxProfiles
                ? 'Delete a profile before creating another.'
                : undefined
            }
            onClick={() => edit({ name: '', description: '', instructions: '' })}
          >
            New profile
          </button>
        ) : null}
      </header>
      {draft ? (
        <form className="tm-profile-editor" onSubmit={(event) => void save(event)}>
          {!draft.id ? (
            <label className="field">
              <span>Start from</span>
              <select
                defaultValue=""
                disabled={busy}
                onChange={(event) => {
                  const starter = AGENT_PROFILE_STARTERS.find(
                    (candidate) => candidate.name === event.target.value
                  );
                  edit(starter ? { ...starter } : { name: '', description: '', instructions: '' });
                }}
              >
                <option value="">Blank profile</option>
                {AGENT_PROFILE_STARTERS.map((starter) => (
                  <option key={starter.name}>{starter.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span>Name</span>
            <input
              required
              value={draft.name}
              maxLength={AGENT_PROFILE_LIMITS.nameCharacters}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>When to use</span>
            <input
              value={draft.description}
              maxLength={AGENT_PROFILE_LIMITS.descriptionCharacters}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Instructions</span>
            <textarea
              required
              aria-describedby={instructionHelpId}
              rows={10}
              value={draft.instructions}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            />
          </label>
          <small id={instructionHelpId}>
            Describe working methods, checks, and useful outputs. Up to 16 KB.
          </small>
          {error ? (
            <p role="alert" className="form-warning">
              {error}
            </p>
          ) : null}
          {deleting ? (
            <div
              className="tm-profile-editor__delete"
              role="group"
              aria-label="Confirm profile deletion"
            >
              <p>
                Delete {draft.name} from the library? Existing tasks and Designs keep their
                saved instructions.
              </p>
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => setDeleting(false)}
              >
                Keep profile
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => void remove()}
              >
                Delete profile
              </button>
            </div>
          ) : null}
          <div className="tm-profile-editor__actions">
            {draft.id && !deleting ? (
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                Delete profile
              </button>
            ) : null}
            <button
              type="button"
              className="outline-button"
              disabled={busy}
              onClick={() => edit(undefined)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={busy || !draft.name.trim() || !draft.instructions.trim()}
            >
              {busy ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </form>
      ) : profiles.length ? (
        <div className="tm-settings__list">
          {profiles.map((profile) => (
            <div className="tm-settings__row" key={profile.id}>
              <div className="tm-profile-row__description">
                <strong>{profile.name}</strong>
                <p>{profile.description}</p>
              </div>
              <div className="tm-profile-row__actions">
                <button
                  type="button"
                  className="tm-settings__button"
                  onClick={() => edit({ ...profile })}
                  aria-label={`Edit ${profile.name}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="tm-settings__button"
                  disabled={profiles.length >= AGENT_PROFILE_LIMITS.maxProfiles}
                  onClick={() =>
                    edit({
                      name: `${profile.name.slice(0, AGENT_PROFILE_LIMITS.nameCharacters - 5)} copy`,
                      description: profile.description,
                      instructions: profile.instructions
                    })
                  }
                  aria-label={`Duplicate ${profile.name}`}
                >
                  Duplicate
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="tm-settings__empty">
          No profiles yet. Create one to reuse instructions across your work.
        </p>
      )}
    </section>
  );
}
