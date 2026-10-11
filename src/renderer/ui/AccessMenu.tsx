import { ChevronDown, ShieldCheck } from 'lucide-react';
import type { AgentExecutionPolicyPreset } from '../../shared/contracts';
import { ActionMenu } from './ActionMenu';

/**
 * What the agent may touch, as one chip in a composer toolbar: the runtime's
 * access presets, then network access, which a preset can fix on or off.
 */
export function AccessMenu({ presets, selected, networkOn, disabled = false, onPresetChange, onNetworkChange }: {
  presets: readonly AgentExecutionPolicyPreset[];
  /** The preset the settings match; none when they were saved outside the presets. */
  selected?: AgentExecutionPolicyPreset;
  networkOn: boolean;
  disabled?: boolean;
  onPresetChange(preset: AgentExecutionPolicyPreset): void;
  onNetworkChange(on: boolean): void;
}) {
  const networkFixed = selected?.networkAccess === 'DISABLED' || selected?.networkAccess === 'REQUIRED';
  const summary = `${selected?.label ?? 'Custom'}${networkOn ? ' · Network' : ''}`;
  return (
    <ActionMenu
      className="tm-composer-chip"
      label={`Access: ${summary}`}
      side="top"
      align="start"
      disabled={disabled || presets.length === 0}
      trigger={<>
        <ShieldCheck size={13} aria-hidden="true" />
        <span>{summary}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </>}
      items={[
        ...presets.map((preset) => ({
          id: preset.id,
          label: preset.label,
          description: preset.detail,
          pressed: preset.id === selected?.id,
          onSelect: () => onPresetChange(preset)
        })),
        {
          id: 'network',
          label: 'Network access',
          pressed: networkOn,
          separated: true,
          disabled: networkFixed,
          disabledReason: networkFixed && selected ? `${selected.label} sets this.` : undefined,
          onSelect: () => onNetworkChange(!networkOn)
        }
      ]}
    />
  );
}

/** Whether network access is on for these settings under their matching preset. */
export function presetNetworkOn(preset: AgentExecutionPolicyPreset | undefined, requested: boolean | undefined): boolean {
  return preset?.networkAccess === 'REQUIRED' || (preset?.networkAccess !== 'DISABLED' && requested === true);
}
