import { useId, useState } from 'react';
import { agentProfilesEqual, type CustomAgentProfile } from '../../shared/agentProfiles';

export function AgentProfileSelect({
  profiles,
  savedProfile,
  value,
  label = 'Agent profile',
  disabled = false,
  disabledReason,
  onChange
}: {
  profiles: readonly CustomAgentProfile[];
  savedProfile?: CustomAgentProfile;
  /** Undefined keeps the saved copy, null selects None, an id selects the library. */
  value?: string | null;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  onChange(value: string | null | undefined): void;
}) {
  const id = useId();
  const selected =
    value === undefined ? savedProfile : profiles.find((profile) => profile.id === value);
  const missing = typeof value === 'string' && !selected;
  return (
    <div className="tm-profile-select">
      <label className="field" htmlFor={id}>
        <span>{label}</span>
        <select
          id={id}
          value={value === undefined && savedProfile ? 'saved' : (value ?? '')}
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          onChange={(event) =>
            onChange(event.target.value === 'saved' ? undefined : event.target.value || null)
          }
        >
          <option value="">None</option>
          {savedProfile ? <option value="saved">{savedProfile.name} · saved</option> : null}
          {missing ? (
            <option value={value!} disabled>
              Profile unavailable
            </option>
          ) : null}
          {profiles
            .filter((profile) => value === profile.id || !agentProfilesEqual(profile, savedProfile))
            .map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
                {profile.id === savedProfile?.id && !agentProfilesEqual(profile, savedProfile)
                  ? ' · updated'
                  : ''}
              </option>
            ))}
        </select>
      </label>
      {selected ? (
        <details className="tm-profile-select__instructions">
          <summary>View instructions</summary>
          {selected.description ? <p>{selected.description}</p> : null}
          <pre>{selected.instructions}</pre>
        </details>
      ) : null}
      {missing ? <p className="form-warning">Choose an available profile or None.</p> : null}
      {!profiles.length && !savedProfile ? (
        <small>Create reusable instructions in Settings → Profiles.</small>
      ) : null}
    </div>
  );
}

export function TaskAgentProfileSetting({
  profiles,
  profile,
  disabled,
  onChange
}: {
  profiles: readonly CustomAgentProfile[];
  profile?: CustomAgentProfile;
  disabled: boolean;
  onChange(profileId: string | null): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="tm-task-profile">
      <AgentProfileSelect
        profiles={profiles}
        savedProfile={profile}
        disabled={disabled || busy}
        disabledReason={
          busy
            ? 'Saving profile…'
            : 'Finish active agent work or resolve recovery before changing its profile.'
        }
        onChange={(profileId) => {
          if (profileId === undefined) return;
          setBusy(true);
          setError(undefined);
          void onChange(profileId)
            .catch((caught: unknown) => {
              setError(caught instanceof Error ? caught.message : 'Could not change the profile.');
            })
            .finally(() => setBusy(false));
        }}
      />
      <small>
        Applies to implementation and follow-ups. Saved instructions stay unchanged until you choose
        a profile here.
      </small>
      {error ? (
        <p role="alert" className="form-warning">
          {error}
        </p>
      ) : null}
    </div>
  );
}
