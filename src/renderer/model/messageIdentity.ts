import type { AgentModel } from '../../shared/contracts';

/** Use runtime-owned names; missing catalog entries retain their exact model identity. */
export function messageModelName(model: string | undefined, fallback = 'Agent', models?: readonly AgentModel[], runtimeId?: string): string {
  if (!model?.trim()) return fallback;
  const candidates = models?.filter((entry) => entry.runtimeId === runtimeId) ?? [];
  const selected = candidates.find((entry) => entry.id === model);
  if (selected) return selected.displayName;
  const executed = candidates.filter((entry) => entry.model === model);
  return executed.length === 1 ? executed[0]!.displayName : model;
}
