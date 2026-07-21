import type {
  PreviewAttachmentPlan,
  PreviewResolvedAttachmentTarget
} from '../../shared/contracts';

export function formatPreviewAttachmentTarget(
  attachment: PreviewAttachmentPlan,
  localTarget?: PreviewResolvedAttachmentTarget
): string {
  const target =
    localTarget ?? (attachment.target.type === 'local' ? undefined : attachment.target);
  const prefix = localTarget ? 'Local binding · ' : '';
  if (!target) return 'Local public target required';
  if (target.type === 'task-preview-route') {
    return `${prefix}Task ${target.targetTaskId} · route ${target.routeId}`;
  }
  if (target.type === 'endpoint') {
    if (
      'scheme' in target &&
      typeof target.scheme === 'string' &&
      'basePath' in target &&
      typeof target.basePath === 'string'
    ) {
      return `${prefix}${target.scheme}://${target.host}:${target.port}${target.basePath}`;
    }
    const database = 'database' in target ? `/${target.database}` : '';
    return `${prefix}${target.host}:${target.port}${database}`;
  }
  return 'Local public target required';
}
