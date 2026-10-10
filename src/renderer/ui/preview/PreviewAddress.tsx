import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { taskManagerApi as api } from '../../api/taskManagerClient';
import type { PreviewAddress } from '../../model/applicationPreviewRuns';
import { CopyGlyph, CopyIconButton, useCopied } from '../CopyIconButton';
import { usePreviewNotify } from './previewPresentation';

/**
 * Opens a serving address through the runtime, which checks it is this preview's loopback
 * endpoint. The browser development host has no desktop shell, so it opens the checked URL itself.
 */
export async function openPreviewAddress(taskId: string, attemptId: string, address?: PreviewAddress): Promise<void> {
  const result = await api.openApplicationPreview({ taskId, attemptId, service: address?.kind === 'host' ? address.service : undefined });
  if (!result.opened) window.open(result.url, '_blank', 'noopener,noreferrer');
}

const kindName = (address: PreviewAddress) => (address.kind === 'host' ? 'Host name' : 'IP address');
/** The kind inside a sentence: "Copy host name", "Copy IP address". */
const kindPhrase = (address: PreviewAddress) => (address.kind === 'host' ? 'host name' : 'IP address');

/**
 * A serving address as a link with its own copy button. A service with more than one address
 * lists the others in a menu, one row each: the row opens it, its copy button copies it.
 * The link text is shortened but still names the real host; the full URL is its title.
 */
export function PreviewAddressLink({ name, addresses, onOpen }: {
  /** The service, for accessible names. */
  name: string;
  addresses: PreviewAddress[];
  onOpen(address: PreviewAddress): void;
}) {
  const notify = usePreviewNotify();
  const copyFailed = () => notify('The address could not be copied.', 'error');
  const [first] = addresses;
  if (!first) return null;
  return (
    <span className="tm-preview-address">
      {first.openable ? (
        <a
          href={first.url}
          title={first.url}
          onClick={(event) => {
            event.preventDefault();
            onOpen(first);
          }}
        >
          {first.text}
        </a>
      ) : (
        <span title={first.url}>{first.text}</span>
      )}
      <CopyIconButton value={first.url} label={`Copy address of ${name}`} size={13} className="tm-iconbtn tm-preview-address__action" onError={copyFailed} />
      {addresses.length > 1 ? (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="tm-iconbtn tm-preview-address__action" aria-label={`All addresses of ${name}`} title="All addresses">
              <ChevronDown size={13} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="tm-action-menu__popover tm-preview-address-menu" side="bottom" align="end" sideOffset={6} collisionPadding={8}>
              {addresses.map((address) => (
                <AddressRow key={address.url} address={address} onOpen={onOpen} onCopyError={copyFailed} />
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </span>
  );
}

/** One address in the menu: the row opens it; the copy item beside it copies it and keeps the menu open. */
function AddressRow({ address, onOpen, onCopyError }: { address: PreviewAddress; onOpen(address: PreviewAddress): void; onCopyError(): void }) {
  const [copied, copy] = useCopied(onCopyError);
  const kind = kindPhrase(address);
  return (
    <div className="tm-preview-address-menu__row">
      <DropdownMenu.Item
        className="tm-action-menu__item tm-preview-address-menu__open"
        disabled={!address.openable}
        aria-label={`Open ${kind} ${address.url}`}
        title={address.url}
        onSelect={() => onOpen(address)}
      >
        <small>{kindName(address)}</small>
        <code>{address.url}</code>
      </DropdownMenu.Item>
      <DropdownMenu.Item
        className="tm-action-menu__item tm-preview-address-menu__copy"
        aria-label={copied ? 'Copied' : `Copy ${kind}`}
        title={copied ? 'Copied' : `Copy ${kind}`}
        onSelect={(event) => {
          event.preventDefault();
          copy(address.url);
        }}
      >
        <CopyGlyph copied={copied} size={13} />
      </DropdownMenu.Item>
    </div>
  );
}
