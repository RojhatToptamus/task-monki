import { ChevronDown, UserRound } from 'lucide-react';
import type { CustomAgentProfile } from '../../shared/agentProfiles';
import { ActionMenu } from './ActionMenu';

/**
 * The saved working instructions for this work, as a composer chip. With no
 * saved profiles there is nothing to choose, so it is not shown.
 */
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
  if (profiles.length === 0 && !value) return null;
  const selected = profiles.find((profile) => profile.id === value);
  const summary = selected?.name ?? (value ? 'Unavailable profile' : 'No profile');
  return (
    <ActionMenu
      className="tm-composer-chip"
      label={`Agent profile: ${summary}`}
      selection="single"
      side="top"
      align="end"
      disabled={disabled}
      trigger={<>
        <UserRound size={14} aria-hidden="true" />
        <span>{summary}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </>}
      items={[
        { id: '', label: 'No profile', pressed: !value, onSelect: () => onChange(undefined) },
        ...profiles.map((profile) => ({
          id: profile.id,
          label: profile.name,
          description: profile.description || undefined,
          pressed: profile.id === value,
          onSelect: () => onChange(profile.id)
        }))
      ]}
    />
  );
}
