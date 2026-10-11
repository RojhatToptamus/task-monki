import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_SEED_PROFILE_MISSING_MESSAGE, resolveDevSeedProfile } from './devSeedProfile';

describe('resolveDevSeedProfile', () => {
  const profileRoot = path.resolve('seed-profile');

  it('refuses seed mode without its profile root instead of opening the real profile', () => {
    for (const root of [undefined, '', '  ']) {
      expect(resolveDevSeedProfile({
        isPackaged: false,
        env: { TASK_MANAGER_DEV_SEED_MODE: '1', ...(root === undefined ? {} : { TASK_MANAGER_PROFILE_ROOT: root }) }
      })).toEqual({ error: DEV_SEED_PROFILE_MISSING_MESSAGE });
    }
  });

  it('opens the seed profile only in development seed mode', () => {
    const env = { TASK_MANAGER_DEV_SEED_MODE: '1', TASK_MANAGER_PROFILE_ROOT: profileRoot };
    expect(resolveDevSeedProfile({ isPackaged: false, env })).toEqual({ profileRoot });
    expect(resolveDevSeedProfile({ isPackaged: true, env })).toEqual({});
    expect(resolveDevSeedProfile({ isPackaged: true, env: { TASK_MANAGER_DEV_SEED_MODE: '1' } })).toEqual({});
    expect(resolveDevSeedProfile({ isPackaged: false, env: { TASK_MANAGER_PROFILE_ROOT: profileRoot } })).toEqual({});
  });
});
