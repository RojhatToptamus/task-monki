import type { DiscourseDefaultPolicy } from '../../shared/discourse';
import { DISCOURSE_RESPONSE_MODE_OPTIONS, discourseResponsePolicyLabel } from '../model/discourse';
import { DiscourseChevronDownIcon, DiscourseModeIcon } from './DiscourseIcons';
import { ActionMenu } from './ActionMenu';

export function DiscourseModeMenu({ value, disabled, onChange }: {
  value: DiscourseDefaultPolicy;
  disabled: boolean;
  onChange(policy: DiscourseDefaultPolicy): void;
}) {
  return (
    <ActionMenu
      className="tm-discourse-mode-menu"
      selection="single"
      align="start"
      disabled={disabled}
      label={`Conversation: ${discourseResponsePolicyLabel(value)}`}
      trigger={<>
        <DiscourseModeIcon policy={value} />
        <span>{discourseResponsePolicyLabel(value)}</span>
        <DiscourseChevronDownIcon />
      </>}
      items={DISCOURSE_RESPONSE_MODE_OPTIONS.map((option) => ({
        label: option.label,
        description: option.description,
        pressed: value === option.policy,
        onSelect: () => onChange(option.policy)
      }))}
    />
  );
}
