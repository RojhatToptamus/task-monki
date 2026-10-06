import type { PreviewStatus } from 'previewhost';
import type { Tone } from './viewTypes';

export interface ApplicationPreviewStatusView {
  label: string;
  tone: Tone;
  note?: string;
  active: boolean;
  needsAttention: boolean;
}

/** Serving state and the latest update are separate facts. A failed update may still serve. */
export function applicationPreviewStatus(
  status?: PreviewStatus,
  approvalPending = false
): ApplicationPreviewStatusView {
  const active = Boolean(status?.active || status?.candidate || status?.busy);
  const servingNote = status?.active ? 'Previous attempt serving' : 'Not serving';
  const result = (
    label: string,
    tone: ApplicationPreviewStatusView['tone'],
    note?: string
  ): ApplicationPreviewStatusView => ({
    label,
    tone,
    note,
    active,
    needsAttention: tone === 'error' || tone === 'action'
  });
  if (status?.cleanup?.length || status?.data?.cleanup || status?.latest?.state === 'cleanup-incomplete')
    return result('Cleanup required', 'error', status.active ? 'App still serving' : undefined);
  if (approvalPending)
    return result('Approval required', 'action', status?.active ? 'Previous attempt serving' : undefined);
  if (status?.candidate)
    return result(status.active ? 'Updating' : 'Starting', 'info', status.active ? servingNote : undefined);
  if (status?.busy) return result('Working', 'info');
  if (status?.latest?.state === 'failed')
    return result(status.active ? 'Update failed' : 'Startup failed', 'error', servingNote);
  if (status?.active && status.latest?.state === 'canceled' && status.latest.id !== status.active.id)
    return result('Update canceled', 'neutral', servingNote);
  if (status?.active) return result('Ready', 'success');
  if (status?.latest?.state === 'canceled') return result('Canceled', 'neutral');
  if (status?.latest || status?.data) return result('Stopped', 'neutral');
  return result('Not started', 'neutral');
}
