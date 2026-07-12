export const DETERMINISTIC_DEV_SEED_ENV_VAR = 'TASK_MANAGER_DETERMINISTIC_SEED';
export const DETERMINISTIC_DEV_SEED_PROVIDER_DISABLED_REASON =
  'Live Codex is disabled for deterministic seed data so synthetic provider records remain inert.';

export function deterministicDevSeedProviderDisabledReason(
  env: NodeJS.ProcessEnv
): string | undefined {
  return env[DETERMINISTIC_DEV_SEED_ENV_VAR] === '1'
    ? DETERMINISTIC_DEV_SEED_PROVIDER_DISABLED_REASON
    : undefined;
}
