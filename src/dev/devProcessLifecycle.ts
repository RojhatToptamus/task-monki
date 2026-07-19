export class DevProcessLifecycle {
  private startupPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private stopping = false;

  get isStopping(): boolean {
    return this.stopping;
  }

  start(startup: () => Promise<void>): Promise<void> {
    if (this.startupPromise) {
      throw new Error('Development process startup has already begun.');
    }
    if (this.stopping) {
      throw new Error('Development process cannot start after shutdown begins.');
    }
    this.startupPromise = startup();
    return this.startupPromise;
  }

  stop(cleanup: () => Promise<void>): Promise<void> {
    this.stopping = true;
    this.shutdownPromise ??= this.stopInternal(cleanup);
    return this.shutdownPromise;
  }

  private async stopInternal(cleanup: () => Promise<void>): Promise<void> {
    let cleanupError: unknown;
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    }

    await this.startupPromise?.catch(() => undefined);

    try {
      await cleanup();
    } catch (error) {
      cleanupError ??= error;
    }

    if (cleanupError) throw cleanupError;
  }
}
