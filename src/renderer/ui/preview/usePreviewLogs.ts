import { useEffect, useRef, useState } from 'react';
import type { PreviewViewModel } from '../../model/preview';
import type { PreviewPanelProps } from './types';

export function usePreviewLogs(
  props: PreviewPanelProps,
  view: PreviewViewModel
) {
  const [value, setValue] = useState<string>();
  const [selectedAttemptId, setSelectedAttemptId] = useState<string>();
  const [selectedStream, setSelectedStream] = useState<'stdout' | 'stderr'>(
    'stdout'
  );
  const selectedAttempt = props.attempts.find(
    (attempt) => attempt.id === (selectedAttemptId ?? view.latestAttempt?.id)
  );
  const selectedArtifactId = selectedAttempt
    ? selectedStream === 'stdout'
      ? selectedAttempt.stdoutArtifactId
      : selectedAttempt.stderrArtifactId
    : undefined;
  const selectedAttemptTerminal = selectedAttempt
    ? ['SUCCEEDED', 'FAILED', 'STOPPED', 'RECOVERY_REQUIRED'].includes(
        selectedAttempt.state
      )
    : true;
  const terminalRef = useRef(selectedAttemptTerminal);
  terminalRef.current = selectedAttemptTerminal;

  useEffect(() => {
    if (value === undefined || !selectedArtifactId) return;
    let canceled = false;
    let offset = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setValue('');
    const poll = async () => {
      let continuePolling = true;
      try {
        const result = await props.onReadLog(
          props.task.id,
          selectedArtifactId,
          offset,
          64 * 1024
        );
        if (canceled) return;
        offset = result.nextOffset;
        if (result.chunk) {
          setValue((current) => `${current ?? ''}${result.chunk}`);
        }
        if (result.endOfFile && terminalRef.current) continuePolling = false;
      } catch {
        continuePolling = false;
      } finally {
        if (!canceled && continuePolling) {
          timer = setTimeout(() => void poll(), 750);
        }
      }
    };
    void poll();
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
    // The selected artifact owns this polling lifecycle; callback identity is intentionally irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArtifactId, value === undefined, props.task.id]);

  return {
    value,
    selectedAttempt,
    selectedStream,
    setSelectedAttemptId,
    setSelectedStream,
    open: () => {
      if (!view.latestAttempt) return;
      setSelectedAttemptId(view.latestAttempt.id);
      setSelectedStream('stdout');
      setValue('');
    },
    openAttempt: (attemptId: string) => {
      setSelectedAttemptId(attemptId);
      setSelectedStream('stdout');
      setValue('');
    },
    close: () => setValue(undefined)
  };
}
