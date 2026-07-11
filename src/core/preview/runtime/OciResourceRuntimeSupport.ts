import { createHash, randomBytes } from 'node:crypto';
import type {
  PreviewOciPublishedPort,
  PreviewOciResourcePlan,
  PreviewOciResourceRecord,
  PreviewResourceRecord
} from '../../../shared/contracts';
import type { OciResourceBinding } from './OciResourceRuntime';

export type OciAdapterKind = PreviewOciResourceRecord['adapterKind'];

export function generatedCredentials(resource: PreviewOciResourcePlan): {
  environment: Record<string, string>;
  username?: string;
  password?: string;
} {
  if (resource.type === 'postgres') {
    const username = `tm_${randomBytes(8).toString('hex')}`;
    const password = randomBytes(32).toString('base64url');
    return {
      username,
      password,
      environment: {
        POSTGRES_USER: username,
        POSTGRES_PASSWORD: password,
        POSTGRES_DB: resource.database
      }
    };
  }
  if (resource.type === 'redis') {
    const password = randomBytes(32).toString('base64url');
    return { password, environment: { REDIS_PASSWORD: password } };
  }
  return { environment: {} };
}

export function resourcePorts(resource: PreviewOciResourcePlan): Record<string, { containerPort: number; protocol: 'tcp' }> {
  if (resource.type === 'postgres') return { postgres: { containerPort: 5432, protocol: 'tcp' } };
  if (resource.type === 'redis') return { redis: { containerPort: 6379, protocol: 'tcp' } };
  return resource.ports;
}

export function resourceCommand(resource: PreviewOciResourcePlan): string[] {
  if (resource.type === 'redis') {
    return ['sh', '-c', 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"'];
  }
  return resource.type === 'oci' ? resource.command ?? [] : [];
}

export function resourceLiteralEnv(resource: PreviewOciResourcePlan): Record<string, string> {
  return resource.type === 'oci' ? resource.env : {};
}

export function resourceVolumeMount(resource: PreviewOciResourcePlan): string | undefined {
  if (resource.type === 'postgres') return '/var/lib/postgresql/data';
  if (resource.type === 'redis') return '/data';
  return resource.dataMount;
}

export function buildBinding(
  resource: PreviewOciResourcePlan,
  credentials: ReturnType<typeof generatedCredentials>,
  requested: ReturnType<typeof resourcePorts>,
  published: PreviewOciPublishedPort[]
): OciResourceBinding {
  const ports: Record<string, number> = {};
  for (const [portId, port] of Object.entries(requested)) {
    const binding = published.find((candidate) =>
      candidate.containerPort === port.containerPort && candidate.protocol === port.protocol
    );
    if (!binding) throw new Error(`OCI resource ${resource.id} did not publish ${portId} on loopback.`);
    ports[portId] = binding.hostPort;
  }
  if (resource.type === 'postgres') {
    return {
      ports,
      postgresUrl: `postgresql://${encodeURIComponent(credentials.username!)}:${encodeURIComponent(credentials.password!)}@127.0.0.1:${ports.postgres}/${encodeURIComponent(resource.database)}`
    };
  }
  if (resource.type === 'redis') {
    return {
      ports,
      redisUrl: `redis://:${encodeURIComponent(credentials.password!)}@127.0.0.1:${ports.redis}/0`
    };
  }
  return { ports };
}

export function ownershipLabels(
  storeIdentity: string,
  input: { taskId: string; generationId: string; markerDigest: string; logicalNodeId: string; kind: OciAdapterKind },
  resourceId: string
): Record<string, string> {
  const prefix = 'io.taskmonki.preview';
  return {
    [`${prefix}.managed`]: 'true',
    [`${prefix}.store`]: storeIdentity,
    [`${prefix}.task`]: input.taskId,
    [`${prefix}.generation`]: input.generationId,
    [`${prefix}.resource`]: resourceId,
    [`${prefix}.logical`]: input.logicalNodeId,
    [`${prefix}.kind`]: input.kind,
    [`${prefix}.marker`]: input.markerDigest
  };
}

export function expectedLabels(storeIdentity: string, resource: PreviewOciResourceRecord): Record<string, string> {
  return ownershipLabels(storeIdentity, {
    taskId: resource.taskId,
    generationId: resource.generationId,
    markerDigest: resource.ownershipMarkerDigest,
    logicalNodeId: resource.logicalNodeId,
    kind: resource.adapterKind
  }, resource.id);
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

export function objectName(kind: OciAdapterKind, generationId: string, logicalId: string, id: string): string {
  const kindName = kind === 'OCI_CONTAINER' ? 'ctr' : kind === 'OCI_NETWORK' ? 'net' : 'vol';
  return `tm-${kindName}-${safeName(generationId)}-${safeName(logicalId)}-${id.slice(0, 8)}`.slice(0, 120);
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 24) || 'preview';
}

export function digestLabels(labels: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(labels).sort()))).digest('hex');
}

export function readLabels(inspection: Record<string, unknown>, kind: OciAdapterKind): Record<string, string> {
  const raw = kind === 'OCI_CONTAINER'
    ? asRecord(asRecord(inspection.Config, 'container Config').Labels, 'container labels')
    : asRecord(inspection.Labels, 'OCI labels');
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
}

export function sameLabels(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export function objectCliType(kind: OciAdapterKind): 'container' | 'network' | 'volume' {
  if (kind === 'OCI_CONTAINER') return 'container';
  if (kind === 'OCI_NETWORK') return 'network';
  return 'volume';
}

export function cleanupRank(resource: PreviewResourceRecord): number {
  if (resource.adapterKind === 'OCI_CONTAINER') return 0;
  if (resource.adapterKind === 'OCI_VOLUME') return 1;
  if (resource.adapterKind === 'OCI_NETWORK') return 2;
  return 3;
}

export function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} is invalid.`);
  return value as Record<string, unknown>;
}

export function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
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
