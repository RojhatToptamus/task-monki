export type WindowChromePlatform = 'macos' | 'windows' | 'linux' | 'other';

export interface TaskManagerShellApi {
  windowChromePlatform: WindowChromePlatform;
  syncWindowChrome(): void;
}
