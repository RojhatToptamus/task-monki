import { createHash } from 'node:crypto';

const PREVIEW_ROUTE_HOSTNAME_VERSION = 'task-monki-preview-route-hostname/v1';
const PREVIEW_CANDIDATE_ROUTE_HOSTNAME_VERSION =
  'task-monki-preview-candidate-route-hostname/v1';
const PREVIEW_ROUTE_LABEL_PATTERN = /^tm-[0-9a-f]{32}$/;
const MAX_IDENTITY_PART_BYTES = 512;

/**
 * Returns the stable public hostname for one task route.
 *
 * The opaque identity keeps the only label before `.localhost` bounded and
 * DNS-safe regardless of repository-controlled route names. Generation,
 * process, workspace, and gateway-port identities are intentionally absent so
 * replacements retain the same browser origin.
 */
export function previewRouteHostname(taskId: string, routeId: string): string {
  return opaquePreviewHostname(PREVIEW_ROUTE_HOSTNAME_VERSION, taskId, routeId);
}

/**
 * Returns a transient origin for one exact Design candidate.
 *
 * The generation identity keeps this route separate from the stable Ready
 * origin. Preview can therefore expose checked work without replacing the
 * last Ready route.
 */
export function previewCandidateRouteHostname(
  taskId: string,
  generationId: string,
  routeId: string
): string {
  assertIdentityPart(generationId, 'generation');
  return opaquePreviewHostname(
    PREVIEW_CANDIDATE_ROUTE_HOSTNAME_VERSION,
    taskId,
    routeId,
    generationId
  );
}

export function isPreviewRouteHostname(hostname: string): boolean {
  const labels = hostname.split('.');
  return (
    labels.length === 2 &&
    PREVIEW_ROUTE_LABEL_PATTERN.test(labels[0]) &&
    labels[1] === 'localhost'
  );
}

function opaquePreviewHostname(version: string, taskId: string, ...parts: string[]): string {
  assertIdentityPart(taskId, 'task');
  parts.forEach((part) => assertIdentityPart(part, 'route'));
  const hash = createHash('sha256').update(version).update('\0').update(taskId);
  for (const part of parts) hash.update('\0').update(part);
  return `tm-${hash.digest('hex').slice(0, 32)}.localhost`;
}

function assertIdentityPart(
  value: string,
  kind: 'task' | 'route' | 'generation'
): void {
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > MAX_IDENTITY_PART_BYTES ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`Preview ${kind} identity is invalid.`);
  }
}
