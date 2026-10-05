import type { ApplicationPreviewInstance } from '../../shared/applicationPreview';
import { applicationPreviewStatus } from './applicationPreviewStatus';

export type PreviewInstanceFilter = 'all' | 'active' | 'attention' | 'inactive';

export function visiblePreviewInstances(
  instances: ApplicationPreviewInstance[],
  query: string,
  filter: PreviewInstanceFilter
): ApplicationPreviewInstance[] {
  const search = query.trim().toLocaleLowerCase();
  return instances.filter((instance) => {
    const state = applicationPreviewStatus(instance.status, instance.approvalPending);
    if (filter === 'active' && !state.active) return false;
    if (filter === 'attention' && !state.needsAttention) return false;
    if (filter === 'inactive' && state.active) return false;
    return [instance.title, instance.kind, instance.repositoryName, instance.branch,
      instance.projectDirectory, instance.status.name, state.label]
      .join(' ').toLocaleLowerCase().includes(search);
  });
}
