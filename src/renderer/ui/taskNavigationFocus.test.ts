import { describe, expect, it } from 'vitest';
import { taskNavigationReturnTarget } from './taskNavigationFocus';

describe('task navigation focus', () => {
  it('returns to the originating task control when it remains connected', () => {
    const origin = element({ connected: true, taskId: 'task-1' });
    const fallback = element({ connected: true });

    expect(taskNavigationReturnTarget(origin, 'task-1', [], fallback)).toBe(origin);
  });

  it('finds the same task after the board rerenders and otherwise uses the app fallback', () => {
    const oldOrigin = element({ connected: false, taskId: 'task-1' });
    const replacement = element({ connected: true, taskId: 'task-1' });
    const other = element({ connected: true, taskId: 'task-2' });
    const fallback = element({ connected: true });

    expect(
      taskNavigationReturnTarget(oldOrigin, 'task-1', [other, replacement], fallback)
    ).toBe(replacement);
    expect(taskNavigationReturnTarget(oldOrigin, 'missing', [other], fallback)).toBe(
      fallback
    );
  });
});

function element({
  connected,
  taskId
}: {
  connected: boolean;
  taskId?: string;
}): HTMLElement {
  return {
    isConnected: connected,
    dataset: taskId ? { taskId } : {}
  } as unknown as HTMLElement;
}
