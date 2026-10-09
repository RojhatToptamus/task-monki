import { parseDocument } from 'yaml';
import type { PreviewDiagnosis } from '../../shared/applicationPreview';

/** The message the Draft action sends. */
export const DRAFT_REQUEST = 'Draft a preview configuration for this project.';

/** The message that opens an investigation of a failed run. */
export function investigationRequest(diagnosis: Pick<PreviewDiagnosis, 'service' | 'title' | 'observed'>): string {
  return `Investigate the ${diagnosis.service ?? 'application'} failure: ${diagnosis.title}. ${diagnosis.observed} Propose a configuration change for review if the configuration caused it; otherwise explain what the project code needs.`;
}

/** "1 step, 2 servers, 1 database": what a proposed file runs, counted by service kind. */
export function proposalSummary(yamlText: string): string | undefined {
  const document = parseDocument(yamlText);
  if (document.errors.length) return undefined;
  const config = document.toJS({ maxAliasCount: 0 }) as { type?: string; services?: Record<string, { type?: string }> } | null;
  if (!config || typeof config !== 'object') return undefined;
  const types = config.type === 'environment'
    ? Object.values(config.services ?? {}).map((service) => service?.type ?? 'service')
    : [config.type ?? 'service'];
  const counts = new Map<string, number>();
  for (const type of types) {
    const noun = type === 'job' ? 'step' : type === 'command' ? 'server' : type === 'worker' ? 'worker'
      : type === 'postgres' || type === 'external-postgres' ? 'database' : type === 'redis' || type === 'external-redis' ? 'cache'
        : type === 'static' ? 'static site' : type === 'attach' ? 'connection' : type === 'compose' ? 'Compose project' : 'service';
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  return [...counts].map(([noun, count]) => `${count} ${count === 1 ? noun : `${noun}s`}`).join(', ') || undefined;
}
