import { ExternalLink } from 'lucide-react';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import type { PreviewAddress } from '../../model/applicationPreviewRuns';
import { CopyIconButton } from '../CopyIconButton';
import { usePreviewNotify } from './previewPresentation';

/**
 * Opens a serving address through the runtime, which checks it is this preview's own address.
 * A service opens at its routed host name. The browser development host has no desktop shell,
 * so it opens the checked URL itself.
 */
export async function openPreviewAddress(taskId: string, attemptId: string, address?: PreviewAddress): Promise<void> {
  const result = await api.openApplicationPreview({ taskId, attemptId, service: address?.service });
  if (!result.opened) window.open(result.url, '_blank', 'noopener,noreferrer');
}

/**
 * A serving address with its two actions beside it: Open and Copy. The label is the service name
 * where the context does not already say it, otherwise the shortened host; the full URL is its title.
 */
export function PreviewAddressActions({ name, address, label, onOpen }: {
  /** The service, for the actions' accessible names. */
  name: string;
  address: PreviewAddress;
  /** What the row shows; the shortened host when omitted. */
  label?: string;
  /** Absent where the address cannot be opened from here. */
  onOpen?(address: PreviewAddress): void;
}) {
  const notify = usePreviewNotify();
  return (
    <span className="tm-preview-address">
      <span className="tm-preview-address__label" title={address.url}>{label ?? address.text}</span>
      {onOpen ? (
        <button
          type="button"
          className="tm-iconbtn tm-preview-address__action"
          aria-label={`Open ${name}`}
          title={`Open ${address.url}`}
          onClick={() => onOpen(address)}
        >
          <ExternalLink size={13} strokeWidth={1.5} aria-hidden="true" />
        </button>
      ) : null}
      <CopyIconButton
        value={address.url}
        label={`Copy address of ${name}`}
        size={13}
        className="tm-iconbtn tm-preview-address__action"
        onError={() => notify('The address could not be copied.', 'error')}
      />
    </span>
  );
}
