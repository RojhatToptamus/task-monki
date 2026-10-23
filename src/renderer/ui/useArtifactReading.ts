import { useEffect, useRef, useState } from 'react';

/**
 * An immutable artifact of a task, read and parsed once. While a newer one of
 * the same task loads, the last reading stays, so what it shows never blinks
 * out under the reader; a reading for another task is ignored.
 */
export function useArtifactReading<T>(
  taskId: string | undefined,
  artifactId: string | undefined,
  read: ((artifactId: string) => Promise<string>) | undefined,
  parse: (text: string) => T | undefined
): T | undefined {
  const [loaded, setLoaded] = useState<{ taskId: string; value?: T }>();
  // The reader's and parser's identities can change every render; only the artifact decides when to read.
  const readRef = useRef(read);
  readRef.current = read;
  const parseRef = useRef(parse);
  parseRef.current = parse;
  useEffect(() => {
    const reader = readRef.current;
    if (!taskId || !artifactId || !reader) return;
    let canceled = false;
    void reader(artifactId).then(
      (text) => { if (!canceled) setLoaded({ taskId, value: parseRef.current(text) }); },
      () => { if (!canceled) setLoaded({ taskId }); }
    );
    return () => { canceled = true; };
  }, [taskId, artifactId]);
  return artifactId && loaded && loaded.taskId === taskId ? loaded.value : undefined;
}
