import { DEV_SEED_AGENTS_DISABLED_REASON } from '../shared/devSeed';

export const DETERMINISTIC_DEV_SEED_ENV_VAR = 'TASK_MANAGER_DETERMINISTIC_SEED';

export function deterministicDevSeedProviderDisabledReason(
  env: NodeJS.ProcessEnv
): string | undefined {
  return env[DETERMINISTIC_DEV_SEED_ENV_VAR] === '1' || env.TASK_MANAGER_DEV_SEED_MODE === '1'
    ? DEV_SEED_AGENTS_DISABLED_REASON
    : undefined;
}
