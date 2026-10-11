import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { OpenTargetRef } from '../../../shared/contracts';
import { taskManagerApi } from '../../api/taskManagerClient';
import { repositoryName } from '../../model/repositories';
import { ActionMenu } from '../ActionMenu';
import { useOpenTargetMenuItems } from '../OpenTargetMenu';

/** Open a run's source folder on the desktop, or pick the app from the shared open-target menu. */
export function SourceFolderActions({ source, target }: { source: string; target: OpenTargetRef }) {
  const name = repositoryName(source);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const items = useOpenTargetMenuItems(target, menuOpen, setError);

  async function openFolder() {
    if (opening) return;
    setOpening(true);
    setError(undefined);
    try {
      const result = await taskManagerApi.executeOpenTargetAction({ target, action: 'open', appId: 'default' });
      if (!result.ok) throw new Error(result.message ?? 'Could not open folder.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open folder.');
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      {error ? <span className="tm-application-preview__error" role="alert">{error}</span> : null}
      <button type="button" className="ghost-button" disabled={opening}
        aria-label={`Open folder ${name}`} aria-busy={opening} onClick={() => void openFolder()}>
        Open folder
      </button>
      <ActionMenu
        label={`Folder actions for ${name}`}
        tooltip="Folder actions"
        side="bottom"
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={<MoreHorizontal size={16} aria-hidden="true" />}
        items={items}
      />
    </>
  );
}
