import path from 'node:path';

export const DEV_SEED_PROFILE_MISSING_MESSAGE =
  'TASK_MANAGER_DEV_SEED_MODE=1 needs TASK_MANAGER_PROFILE_ROOT set to the development seed profile, or Task Monki would open your own profile with live agents. Run `npm run dev:seed` and source .local/task-monki-dev-seed/dev-api.env, or unset TASK_MANAGER_DEV_SEED_MODE.';

/**
 * Development only: with the environment `npm run dev:seed` writes, the desktop shell opens
 * the deterministic seed profile with live agents off. Seed mode without its profile root is
 * refused instead of opening the person's own profile. Packaged builds ignore both variables.
 */
export function resolveDevSeedProfile(input: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
}): { profileRoot?: string; error?: string } {
  if (input.isPackaged || input.env.TASK_MANAGER_DEV_SEED_MODE !== '1') return {};
  const profileRoot = input.env.TASK_MANAGER_PROFILE_ROOT?.trim();
  if (!profileRoot) return { error: DEV_SEED_PROFILE_MISSING_MESSAGE };
  return { profileRoot: path.resolve(profileRoot) };
}
