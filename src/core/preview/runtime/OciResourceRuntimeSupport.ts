import { createHash } from 'node:crypto';
import type {
  PreviewManagedEnvironmentRecord,
  PreviewManagedResourceRecord,
  PreviewOciObjectIdentity,
  PreviewOciResourcePlan
} from '../../../shared/contracts';
export { boundedPreviewFailure as boundedError } from '../PreviewFailure';

export type OciObjectKind = 'container' | 'network' | 'volume';

const LABEL_PREFIX = 'io.taskmonki.preview';

export function environmentLabels(
  storeIdentity: string,
  input: { taskId: string; environmentId: string; markerDigest: string }
): Record<string, string> {
  return {
    [`${LABEL_PREFIX}.managed`]: 'true',
    [`${LABEL_PREFIX}.store`]: storeIdentity,
    [`${LABEL_PREFIX}.task`]: input.taskId,
    [`${LABEL_PREFIX}.environment`]: input.environmentId,
    [`${LABEL_PREFIX}.owner`]: 'environment',
    [`${LABEL_PREFIX}.kind`]: 'network',
    [`${LABEL_PREFIX}.marker`]: input.markerDigest
  };
}

export function managedResourceLabels(
  storeIdentity: string,
  input: {
    taskId: string;
    environmentId: string;
    managedResourceId: string;
    logicalResourceId: string;
    markerDigest: string;
    kind: 'container' | 'volume';
  }
): Record<string, string> {
  return {
    [`${LABEL_PREFIX}.managed`]: 'true',
    [`${LABEL_PREFIX}.store`]: storeIdentity,
    [`${LABEL_PREFIX}.task`]: input.taskId,
    [`${LABEL_PREFIX}.environment`]: input.environmentId,
    [`${LABEL_PREFIX}.resource`]: input.managedResourceId,
    [`${LABEL_PREFIX}.logical`]: input.logicalResourceId,
    [`${LABEL_PREFIX}.owner`]: 'managed-resource',
    [`${LABEL_PREFIX}.kind`]: input.kind,
    [`${LABEL_PREFIX}.marker`]: input.markerDigest
  };
}

export function expectedEnvironmentLabels(
  storeIdentity: string,
  environment: PreviewManagedEnvironmentRecord
): Record<string, string> {
  return environmentLabels(storeIdentity, {
    taskId: environment.taskId,
    environmentId: environment.id,
    markerDigest: environment.ownershipMarkerDigest
  });
}

export function expectedManagedResourceLabels(
  storeIdentity: string,
  resource: PreviewManagedResourceRecord,
  kind: 'container' | 'volume'
): Record<string, string> {
  return managedResourceLabels(storeIdentity, {
    taskId: resource.taskId,
    environmentId: resource.environmentId,
    managedResourceId: resource.id,
    logicalResourceId: resource.logicalResourceId,
    markerDigest: resource.ownershipMarkerDigest,
    kind
  });
}

export function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).sort().flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

export function limitArgs(resource: PreviewOciResourcePlan): string[] {
  const result: string[] = [];
  if (resource.limits.cpus !== undefined) result.push('--cpus', String(resource.limits.cpus));
  if (resource.limits.memoryMb !== undefined) result.push('--memory', `${resource.limits.memoryMb}m`);
  if (resource.limits.pids !== undefined) result.push('--pids-limit', String(resource.limits.pids));
  return result;
}

export function resourcePorts(resource: PreviewOciResourcePlan): Record<string, { containerPort: number; protocol: 'tcp' }> {
  return resource.type === 'postgres'
    ? { postgres: { containerPort: 5432, protocol: 'tcp' } }
    : { redis: { containerPort: 6379, protocol: 'tcp' } };
}

export function resourceVolumeMount(resource: PreviewOciResourcePlan): string {
  return resource.type === 'postgres' ? '/var/lib/postgresql/data' : '/data';
}

export function resourceCommand(resource: PreviewOciResourcePlan): string[] {
  if (resource.type === 'redis') {
    return [
      'sh', '-eu', '-c',
      '{ printf "appendonly yes\\nrequirepass "; head -n 1; } | redis-server -'
    ];
  }
  return [
    'sh', '-eu', '-c',
    'head -n 1 | POSTGRES_PASSWORD_FILE=/dev/stdin docker-entrypoint.sh postgres'
  ];
}

export function objectName(kind: OciObjectKind, ownerId: string, logicalId: string): string {
  const abbreviation = kind === 'container' ? 'ctr' : kind === 'network' ? 'net' : 'vol';
  return `tm-${abbreviation}-${safeName(ownerId)}-${safeName(logicalId)}`.slice(0, 120);
}

export function digestLabels(labels: Record<string, string>): string {
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(labels).sort())));
}

export function digestResourcePlan(resource: PreviewOciResourcePlan): string {
  return sha256(JSON.stringify(sortValue(resource)));
}

export function bindingDigest(input: {
  id: string;
  type: 'postgres' | 'redis';
  host: string;
  ports: Record<string, number>;
  username?: string;
  database?: string;
}): string {
  return sha256(JSON.stringify(sortValue(input)));
}

export function readLabels(inspection: Record<string, unknown>, kind: OciObjectKind): Record<string, string> {
  const raw = kind === 'container'
    ? asRecord(asRecord(inspection.Config, 'container Config').Labels, 'container labels')
    : asRecord(inspection.Labels, 'OCI labels');
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
}

export function sameLabels(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export function createObjectIdentity(input: {
  engine: PreviewOciObjectIdentity['engine'];
  objectName: string;
  labels: Record<string, string>;
  imageReference?: string;
  imageId?: string;
}): PreviewOciObjectIdentity {
  return {
    engine: input.engine,
    objectName: input.objectName,
    labelsDigest: digestLabels(input.labels),
    imageReference: input.imageReference,
    imageId: input.imageId
  };
}

export function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} is invalid.`);
  return value as Record<string, unknown>;
}

export function isArchitectureMismatch(error: unknown): boolean {
  return /no matching manifest|no match for platform|exec format error|image.*platform.*does not match/i
    .test(error instanceof Error ? error.message : String(error));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Preview startup canceled.');
  error.name = 'AbortError';
  throw error;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Preview operation canceled.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish(new Error('Preview operation canceled.'));
    function finish(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 32) || 'preview';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)])
    );
  }
  return value;
}
