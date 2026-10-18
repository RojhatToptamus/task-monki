import { isDeepStrictEqual } from 'node:util';
import { parsePreviewSpec, type AuthorizationRequest, type PreviewRuntime, type PreviewSpec } from 'previewhost';
import { REPLAY_NAME_PATTERN } from './ReplayDerivation';

/**
 * Who may start clean copies. The person grants one lease per task and recipe template ("Run
 * clean copies of this app"): it lives in memory, ends when Task Monki quits, and covers a
 * bounded number of environment starts. Previewhost asks before every start; only a `br-` name
 * Task Monki is starting right now, with exactly the spec it derived, under a current lease with
 * starts left, is approved. Everything else about `br-` names is refused at once, never parked.
 */

export const REPLAY_LEASE_STARTS = 30;

interface ReplayLease {
  templateDigest: string;
  startsLeft: number;
  grantedAt: string;
}

interface ExpectedStart {
  taskId: string;
  templateDigest: string;
  spec: PreviewSpec;
  secretIds: string[];
}

export class ReplayAuthorization {
  private readonly leases = new Map<string, ReplayLease>();
  private readonly expected = new Map<string, ExpectedStart>();
  private readonly owned = new Set<string>();

  constructor(private readonly runtime: () => PreviewRuntime) {}

  grant(taskId: string, templateDigest: string, starts = REPLAY_LEASE_STARTS): void {
    const current = this.leases.get(taskId);
    if (current && current.templateDigest === templateDigest) {
      current.startsLeft += starts;
      return;
    }
    this.leases.set(taskId, { templateDigest, startsLeft: starts, grantedAt: new Date().toISOString() });
  }

  lease(taskId: string, templateDigest: string): { startsLeft: number } | undefined {
    const lease = this.leases.get(taskId);
    return lease && lease.templateDigest === templateDigest && lease.startsLeft > 0 ? { startsLeft: lease.startsLeft } : undefined;
  }

  anyLease(taskId: string): { startsLeft: number } | undefined {
    const lease = this.leases.get(taskId);
    return lease ? { startsLeft: lease.startsLeft } : undefined;
  }

  revoke(taskId: string): void {
    this.leases.delete(taskId);
  }

  /** Marks a `br-` name as one Task Monki owns, so cleanup operations on it are allowed. */
  own(name: string): void {
    if (REPLAY_NAME_PATTERN.test(name)) this.owned.add(name);
  }

  disown(name: string): void {
    this.owned.delete(name);
    this.expected.delete(name);
  }

  /** Registers the start Task Monki is about to make; Previewhost's authorization consumes it. */
  expectStart(name: string, start: ExpectedStart): void {
    this.own(name);
    this.expected.set(name, { ...start, spec: structuredClone(start.spec) });
  }

  cancelStart(name: string): void {
    this.expected.delete(name);
  }

  clear(): void {
    this.leases.clear();
    this.expected.clear();
  }

  /**
   * Previewhost's authorization callback for replay names. Returns undefined for every other
   * name, so ordinary previews keep their own approval path.
   */
  async authorize(request: AuthorizationRequest): Promise<boolean | undefined> {
    const name = requestName(request);
    if (name === undefined || !REPLAY_NAME_PATTERN.test(name)) return undefined;
    switch (request.operation) {
      case 'start': {
        const expected = this.expected.get(name);
        this.expected.delete(name);
        if (!expected || request.rerunJob !== undefined || request.signal.aborted) return false;
        let parsed: unknown;
        try {
          parsed = parsePreviewSpec(expected.spec);
        } catch {
          return false;
        }
        if (!isDeepStrictEqual(request.spec, parsed)) return false;
        const references = secretIdsOf(request.spec);
        if (references.some((id) => !expected.secretIds.includes(id))) return false;
        const lease = this.leases.get(expected.taskId);
        if (!lease || lease.templateDigest !== expected.templateDigest || lease.startsLeft < 1) return false;
        lease.startsLeft -= 1;
        if (references.length > 0) {
          const setup = await this.runtime().prepareSecretSetup(request.spec, request.signal);
          await setup.approve?.(request.signal);
        }
        return !request.signal.aborted;
      }
      case 'replace':
        return false;
      case 'delete-data':
      case 'recover-data':
        return this.owned.has(name);
      case 'secrets-setup':
        return false;
      default:
        return false;
    }
  }
}

function requestName(request: AuthorizationRequest): string | undefined {
  switch (request.operation) {
    case 'start':
    case 'replace':
      return request.spec.name;
    case 'delete-data':
    case 'recover-data':
      return request.name;
    case 'secrets-setup':
      return request.spec?.name;
    default:
      return undefined;
  }
}

function secretIdsOf(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) secretIdsOf(item, found);
    return found;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.secret === 'string' && Object.keys(record).length === 1) {
    if (!found.includes(record.secret)) found.push(record.secret);
    return found;
  }
  for (const item of Object.values(record)) secretIdsOf(item, found);
  return found;
}
