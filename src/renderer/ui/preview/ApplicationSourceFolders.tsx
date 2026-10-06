import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis, Folder } from 'lucide-react';
import type { OpenTargetRef } from '../../../shared/contracts';
import { taskManagerApi } from '../../api/taskManagerClient';
import { openTargetMenuPosition } from '../../model/openTargetMenu';
import { repositoryDisplayPath, repositoryName } from '../../model/repositories';
import { DisclosureChevron } from '../DisclosureChevron';
import { OpenTargetContextMenu } from '../OpenTargetMenu';
import { message } from './previewPresentation';

export function ApplicationSourceFolders({ taskId, attemptId, sources }: {
  taskId: string;
  attemptId: string;
  sources: string[];
}) {
  return (
    <details className="tm-application-preview__sources">
      <summary><DisclosureChevron />Source folders</summary>
      <ul className="tm-preview-source-list">
        {sources.map((source, sourceIndex) => (
          <SourceFolder key={source} source={source}
            target={{ type: 'previewSource', taskId, attemptId, sourceIndex }} />
        ))}
      </ul>
    </details>
  );
}

function SourceFolder({ source, target }: { source: string; target: OpenTargetRef }) {
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
      setError(message(cause));
    } finally {
      setOpening(false);
    }
  }

  return (
    <li className="tm-preview-source" aria-label={name}>
      <Folder size={16} strokeWidth={1.5} aria-hidden="true" />
      <div className="tm-preview-source__location">
        <strong title={source}>{name}</strong>
        {error
          ? <p className="tm-application-preview__error" role="alert">{error}</p>
          : <code title={source}>{repositoryDisplayPath(source)}</code>}
      </div>
      <div className="tm-preview-source__actions">
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
      </div>
      {menuPosition ? createPortal(
        <OpenTargetContextMenu target={target} position={menuPosition}
          onClose={closeMenu} />, document.body
      ) : null}
    </li>
  );
}
