import { createHash } from 'node:crypto';

const PREVIEW_ROUTE_HOSTNAME_VERSION = 'task-monki-preview-route-hostname/v1';
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
  assertIdentityPart(taskId, 'task');
  assertIdentityPart(routeId, 'route');
  const identity = createHash('sha256')
    .update(PREVIEW_ROUTE_HOSTNAME_VERSION)
    .update('\0')
    .update(taskId)
    .update('\0')
    .update(routeId)
    .digest('hex')
    .slice(0, 32);
  return `tm-${identity}.localhost`;
}

export function isPreviewRouteHostname(hostname: string): boolean {
  const labels = hostname.split('.');
  return (
    labels.length === 2 &&
    PREVIEW_ROUTE_LABEL_PATTERN.test(labels[0]) &&
    labels[1] === 'localhost'
  );
}

function assertIdentityPart(value: string, kind: 'task' | 'route'): void {
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > MAX_IDENTITY_PART_BYTES ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`Preview ${kind} identity is invalid.`);
  }
}
