import { execFilePortable } from '../../process/portableChildProcess';
import {
  MacProcessIdentityInspector,
  type ProcessIdentityInspector
} from './NativeLauncherHost';

interface ListenerObservation {
  pid: number;
  address: string;
}

export interface PreviewListenerInspector {
  assertOwnedLoopback(port: number, processGroupId: number): Promise<void>;
}

export class MacPreviewListenerInspector implements PreviewListenerInspector {
  constructor(
    private readonly processInspector: ProcessIdentityInspector = new MacProcessIdentityInspector()
  ) {}

  async assertOwnedLoopback(port: number, processGroupId: number): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('Phase 1 listener ownership inspection is supported on macOS only.');
    }
    let stdout: string;
    try {
      ({ stdout } = await execFilePortable(
        '/usr/sbin/lsof',
        ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'],
        { timeout: 2_000, maxBuffer: 64 * 1024 }
      ));
    } catch {
      throw new Error(`No owned listener was observed on allocated preview port ${port}.`);
    }
    const listeners = parseListeners(stdout);
    if (listeners.length === 0) {
      throw new Error(`No owned listener was observed on allocated preview port ${port}.`);
    }
    for (const listener of listeners) {
      if (!isLoopbackAddress(listener.address, port)) {
        throw new Error(
          `Preview service exposed allocated port ${port} on non-loopback address ${listener.address}.`
        );
      }
      const identity = await this.processInspector.inspect(listener.pid);
      if (identity.processGroupId !== processGroupId) {
        throw new Error(
          `Preview port ${port} is owned by process ${listener.pid} outside the recorded target group.`
        );
      }
    }
  }
}

function parseListeners(output: string): ListenerObservation[] {
  const listeners: ListenerObservation[] = [];
  let pid: number | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n') && pid && Number.isInteger(pid)) {
      listeners.push({ pid, address: line.slice(1) });
    }
  }
  return listeners;
}

function isLoopbackAddress(address: string, port: number): boolean {
  return address === `127.0.0.1:${port}` || address === `[::1]:${port}`;
}
