import { useEffect, useRef, useState } from 'react';
import type { RemoteWorkSnapshot, TaskRemoteSource } from '../../shared/contracts';
import { parseRemoteWorkSnapshot } from '../model/remoteWork';

/**
 * The text a task captured from its issue or pull request. It is immutable, so
 * it is read once per artifact; a response for another task is ignored.
 */
export function useRemoteSourceSnapshot(
  source: TaskRemoteSource | undefined,
  read: ((artifactId: string) => Promise<string>) | undefined
): RemoteWorkSnapshot | undefined {
  const [loaded, setLoaded] = useState<{ artifactId: string; snapshot?: RemoteWorkSnapshot }>();
  // The reader's identity can change every render; only the artifact decides when to read.
  const readRef = useRef(read);
  readRef.current = read;
  const artifactId = source?.snapshotArtifactId;
  const number = source?.number;
  useEffect(() => {
    const reader = readRef.current;
    if (!artifactId || number === undefined || !reader) return;
    let canceled = false;
    void reader(artifactId).then(
      (text) => { if (!canceled) setLoaded({ artifactId, snapshot: parseRemoteWorkSnapshot(text, number) }); },
      () => { if (!canceled) setLoaded({ artifactId }); }
    );
    return () => { canceled = true; };
  }, [artifactId, number]);
  return loaded && loaded.artifactId === artifactId ? loaded.snapshot : undefined;
}
