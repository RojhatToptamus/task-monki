import type { AgentSessionControlSet } from '../../shared/contracts';

export type NativeSessionControls = AgentSessionControlSet;

/** Selects typed adapter-owned controls without interpreting opaque native metadata. */
export function selectNativeSessionControls(
  controlSets: readonly AgentSessionControlSet[] | undefined,
  localSessionId: string | undefined
): NativeSessionControls | undefined {
  if (!localSessionId) return undefined;
  return controlSets?.find((candidate) => candidate.localSessionId === localSessionId);
}
