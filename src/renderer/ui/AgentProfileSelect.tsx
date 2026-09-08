import type { CustomAgentProfile } from '../../shared/agentProfiles';

export function AgentProfileSelect({
  profiles,
  value,
  disabled,
  onChange
}: {
  profiles: readonly CustomAgentProfile[];
  value?: string;
  disabled?: boolean;
  onChange(profileId: string | undefined): void;
}) {
  const selected = profiles.find((profile) => profile.id === value);
  return (
    <label className="tm-profile-picker">
      <span>Profile</span>
      <select
        aria-label="Agent profile"
        value={value ?? ''}
        disabled={disabled}
        title={selected?.description || undefined}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">None</option>
        {value && !selected ? <option value={value} disabled>Unavailable</option> : null}
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>{profile.name}</option>
        ))}
      </select>
    </label>
  );
}
