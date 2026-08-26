export type SoftwareUpdateStatus =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface SoftwareUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface SoftwareUpdateState {
  status: SoftwareUpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  lastCheckedAt: string | null;
  progress: SoftwareUpdateProgress | null;
  errorMessage: string | null;
}
