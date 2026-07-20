import { describe, expect, it, vi } from 'vitest';
import { DevProcessLifecycle } from './devProcessLifecycle';

describe('development process lifecycle', () => {
  it('starts SIGINT cleanup immediately and sweeps resources created while startup settles', async () => {
    const lifecycle = new DevProcessLifecycle();
    const resources = new Set(['initializing-service']);
    let cancelInitialization: (() => void) | undefined;
    let initializationCanceled = false;
    const cleanup = vi.fn(async () => {
      resources.clear();
      cancelInitialization?.();
    });

    const startup = lifecycle.start(async () => {
      await new Promise<void>((resolve) => {
        cancelInitialization = () => {
          initializationCanceled = true;
          resolve();
        };
      });
      resources.add('late-token-lease');
    });
    const firstStop = lifecycle.stop(cleanup);
    const secondStop = lifecycle.stop(cleanup);

    expect(lifecycle.isStopping).toBe(true);
    expect(initializationCanceled).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await Promise.all([startup, firstStop, secondStop]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(resources).toEqual(new Set());
  });

  it('still cleans up after startup rejects', async () => {
    const lifecycle = new DevProcessLifecycle();
    const startup = lifecycle.start(async () => {
      throw new Error('startup failed');
    });
    const cleanup = vi.fn(async () => undefined);

    await expect(startup).rejects.toThrow('startup failed');
    await lifecycle.stop(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('performs the final sweep when the first cleanup attempt fails', async () => {
    const lifecycle = new DevProcessLifecycle();
    let releaseStartup: (() => void) | undefined;
    const startup = lifecycle.start(
      () =>
        new Promise<void>((resolve) => {
          releaseStartup = resolve;
        })
    );
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        releaseStartup?.();
        throw new Error('first cleanup failed');
      })
      .mockResolvedValueOnce(undefined);

    await expect(lifecycle.stop(cleanup)).rejects.toThrow('first cleanup failed');
    await startup;
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
