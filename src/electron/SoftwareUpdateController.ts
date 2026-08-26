import type { SoftwareUpdateState } from '../shared/softwareUpdate';

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

interface UpdateInfoLike {
  version: string;
}

interface DownloadProgressLike {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface SoftwareUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  disableWebInstaller: boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export class SoftwareUpdateController {
  private state: SoftwareUpdateState;
  private interval: ReturnType<typeof setInterval> | undefined;
  private operation: 'check' | 'download' | null = null;
  private readonly listeners: Array<[string, (...args: any[]) => void]> = [];

  constructor(
    private readonly updater: SoftwareUpdater,
    private readonly enabled: boolean,
    currentVersion: string,
    private readonly publish: (state: SoftwareUpdateState) => void,
    private readonly now: () => Date = () => new Date()
  ) {
    this.state = {
      status: enabled ? 'idle' : 'unavailable',
      currentVersion,
      availableVersion: null,
      lastCheckedAt: null,
      progress: null,
      errorMessage: null
    };
    if (!enabled) return;

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    this.listen('checking-for-update', () => {
      this.setState({ status: 'checking', progress: null, errorMessage: null });
    });
    this.listen('update-available', (info: UpdateInfoLike) => {
      const version = validVersion(info?.version);
      if (!version) {
        this.fail('Could not read the available update.');
        return;
      }
      this.operation = null;
      this.setState({
        status: 'available',
        availableVersion: version,
        lastCheckedAt: this.now().toISOString(),
        progress: null,
        errorMessage: null
      });
    });
    this.listen('update-not-available', () => {
      this.operation = null;
      this.setState({
        status: 'up-to-date',
        availableVersion: null,
        lastCheckedAt: this.now().toISOString(),
        progress: null,
        errorMessage: null
      });
    });
    this.listen('download-progress', (progress: DownloadProgressLike) => {
      this.setState({
        status: 'downloading',
        progress: normalizeProgress(progress),
        errorMessage: null
      });
    });
    this.listen('update-downloaded', (info: UpdateInfoLike) => {
      this.operation = null;
      this.setState({
        status: 'downloaded',
        availableVersion: validVersion(info?.version) ?? this.state.availableVersion,
        progress: null,
        errorMessage: null
      });
    });
    this.listen('error', () => {
      this.fail(
        this.operation === 'download'
          ? 'Could not download the update.'
          : 'Could not check for updates.'
      );
    });
  }

  start(): void {
    if (!this.enabled || this.interval) return;
    void this.checkForUpdates();
    this.interval = setInterval(() => {
      if (['idle', 'up-to-date', 'error'].includes(this.state.status)) {
        void this.checkForUpdates();
      }
    }, UPDATE_CHECK_INTERVAL_MS);
    this.interval.unref?.();
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    for (const [event, listener] of this.listeners) {
      this.updater.off(event, listener);
    }
    this.listeners.length = 0;
  }

  getState(): SoftwareUpdateState {
    return structuredClone(this.state);
  }

  async checkForUpdates(): Promise<SoftwareUpdateState> {
    if (!this.enabled || ['available', 'downloading', 'downloaded'].includes(this.state.status)) {
      return this.getState();
    }
    if (this.operation) return this.getState();
    this.operation = 'check';
    this.setState({ status: 'checking', progress: null, errorMessage: null });
    try {
      await this.updater.checkForUpdates();
      if (this.state.status === 'checking') {
        this.operation = null;
        this.setState({
          status: 'up-to-date',
          availableVersion: null,
          lastCheckedAt: this.now().toISOString(),
          errorMessage: null
        });
      }
    } catch {
      if (this.operation === 'check') this.fail('Could not check for updates.');
    }
    return this.getState();
  }

  async downloadUpdate(): Promise<SoftwareUpdateState> {
    if (!this.enabled || !this.state.availableVersion || this.state.status === 'downloaded') {
      return this.getState();
    }
    if (this.operation) return this.getState();
    this.operation = 'download';
    this.setState({ status: 'downloading', progress: null, errorMessage: null });
    try {
      await this.updater.downloadUpdate();
      if (this.state.status === 'downloading') {
        this.operation = null;
        this.setState({ status: 'downloaded', progress: null, errorMessage: null });
      }
    } catch {
      if (this.operation === 'download') this.fail('Could not download the update.');
    }
    return this.getState();
  }

  hasDownloadedUpdate(): boolean {
    return this.state.status === 'downloaded';
  }

  installUpdate(relaunch: boolean): void {
    if (!this.hasDownloadedUpdate()) {
      throw new Error('No downloaded update is ready to install.');
    }
    this.updater.autoRunAppAfterInstall = relaunch;
    this.updater.quitAndInstall(!relaunch, relaunch);
  }

  private listen(event: string, listener: (...args: any[]) => void): void {
    this.listeners.push([event, listener]);
    this.updater.on(event, listener);
  }

  private fail(message: string): void {
    this.operation = null;
    this.setState({ status: 'error', progress: null, errorMessage: message });
  }

  private setState(patch: Partial<SoftwareUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.publish(this.getState());
  }
}

function validVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
    ? value
    : undefined;
}

function normalizeProgress(value: DownloadProgressLike) {
  const total = finiteNonNegative(value?.total);
  const transferred = Math.min(total, finiteNonNegative(value?.transferred));
  return {
    percent: Math.min(100, Math.max(0, finiteNonNegative(value?.percent))),
    transferred,
    total,
    bytesPerSecond: finiteNonNegative(value?.bytesPerSecond)
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}
