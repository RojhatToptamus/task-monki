import type { SoftwareUpdateState } from './softwareUpdate';

export type WindowChromePlatform = 'macos' | 'windows' | 'linux' | 'other';

export interface TaskManagerShellApi {
  windowChromePlatform: WindowChromePlatform;
  syncWindowChrome(): void;
  getSoftwareUpdateState(): Promise<SoftwareUpdateState>;
  checkForSoftwareUpdates(): Promise<SoftwareUpdateState>;
  downloadSoftwareUpdate(): Promise<SoftwareUpdateState>;
  installSoftwareUpdate(): Promise<void>;
  onSoftwareUpdateState(listener: (state: SoftwareUpdateState) => void): () => void;
}
