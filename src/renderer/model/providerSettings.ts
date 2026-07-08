import type { AgentExecutionSettings } from '../../shared/contracts';

export type ProviderSettingState =
  | 'match'
  | 'mismatch'
  | 'not-observed'
  | 'provider-default';

export interface ProviderSettingField {
  key: keyof AgentExecutionSettings;
  label: string;
}

export const PROVIDER_SETTING_FIELDS: ProviderSettingField[] = [
  { key: 'model', label: 'Model' },
  { key: 'modelProvider', label: 'Model provider' },
  { key: 'reasoningEffort', label: 'Reasoning effort' },
  { key: 'serviceTier', label: 'Service tier' },
  { key: 'sandbox', label: 'Sandbox' },
  { key: 'networkAccess', label: 'Network' },
  { key: 'approvalPolicy', label: 'Approval policy' },
  { key: 'approvalsReviewer', label: 'Approval reviewer' }
];

export function compareProviderSetting(
  requested: AgentExecutionSettings[keyof AgentExecutionSettings] | undefined,
  observed: AgentExecutionSettings[keyof AgentExecutionSettings] | undefined
): ProviderSettingState {
  if (observed === undefined) {
    return 'not-observed';
  }
  if (requested === undefined) {
    return 'provider-default';
  }
  return normalizeSettingValue(requested) === normalizeSettingValue(observed)
    ? 'match'
    : 'mismatch';
}

export function isProviderSettingDifference(state: ProviderSettingState): boolean {
  return state === 'mismatch';
}

function normalizeSettingValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}
