import { describe, expect, it, vi } from 'vitest';
import { DevProcessLifecycle } from './devProcessLifecycle';

describe('development process lifecycle', () => {
  it('waits for in-flight startup before cleaning resources exactly once', async () => {
    const lifecycle = new DevProcessLifecycle();
    let releaseStartup: (() => void) | undefined;
    let resourceCreated = false;
    const cleanup = vi.fn(async () => {
      expect(resourceCreated).toBe(true);
    });

    const startup = lifecycle.start(
      () =>
        new Promise<void>((resolve) => {
          releaseStartup = () => {
            resourceCreated = true;
            resolve();
          };
        })
    );
    const firstStop = lifecycle.stop(cleanup);
    const secondStop = lifecycle.stop(cleanup);

    expect(lifecycle.isStopping).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    releaseStartup?.();
    await Promise.all([startup, firstStop, secondStop]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('still cleans up after startup rejects', async () => {
    const lifecycle = new DevProcessLifecycle();
    const startup = lifecycle.start(async () => {
      throw new Error('startup failed');
    });
    const cleanup = vi.fn(async () => undefined);

    await expect(startup).rejects.toThrow('startup failed');
    await lifecycle.stop(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
