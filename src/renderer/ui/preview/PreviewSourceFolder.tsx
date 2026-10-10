import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis } from 'lucide-react';
import type { OpenTargetRef } from '../../../shared/contracts';
import { taskManagerApi } from '../../api/taskManagerClient';
import { openTargetMenuPosition } from '../../model/openTargetMenu';
import { repositoryName } from '../../model/repositories';
import { OpenTargetContextMenu } from '../OpenTargetMenu';

/** Open a run's source folder on the desktop, or pick the app from the shared open-target menu. */
export function SourceFolderActions({ source, target }: { source: string; target: OpenTargetRef }) {
  const name = repositoryName(source);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number }>();
  const closeMenu = useCallback(() => setMenuPosition(undefined), []);

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
      <button type="button" className="tm-preview-icon-button"
        aria-label={`Folder actions for ${name}`} title="Folder actions"
        aria-haspopup="menu" aria-expanded={!!menuPosition}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuPosition(openTargetMenuPosition(rect.right, rect.bottom));
        }}>
        <Ellipsis size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {menuPosition ? createPortal(
        <OpenTargetContextMenu target={target} position={menuPosition} onClose={closeMenu} />, document.body
      ) : null}
    </>
  );
}
