import { useEffect, useState } from 'react';
import { taskManagerApi } from '../../api/taskManagerClient';

/**
 * A screenshot Bug Replay kept. Read once per file; the object URL is revoked when the image
 * leaves the screen, so evidence never accumulates in renderer memory.
 */
export function BugImage({ taskId, fileId, alt, className }: { taskId: string; fileId: string; alt: string; className?: string }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    void taskManagerApi.readBugReplayImage({ taskId, fileId }).then(
      (image) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(image.data)], { type: image.mimeType }));
        setUrl(objectUrl);
      },
      () => {
        if (!disposed) setFailed(true);
      }
    );
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [taskId, fileId]);
  if (failed) return <span className={`tm-bugimage tm-bugimage--missing ${className ?? ''}`.trim()}>Screenshot unavailable</span>;
  return url
    ? <img className={`tm-bugimage ${className ?? ''}`.trim()} src={url} alt={alt} draggable={false} />
    : <span className={`tm-bugimage tm-bugimage--loading ${className ?? ''}`.trim()} aria-label={alt} role="img" />;
}
