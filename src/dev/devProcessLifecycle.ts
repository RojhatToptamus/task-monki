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
    this.shutdownPromise ??= (async () => {
      await this.startupPromise?.catch(() => undefined);
      await cleanup();
    })();
    return this.shutdownPromise;
  }
}
