import { isDeepStrictEqual } from 'node:util';
import { parsePreviewSpec, type AuthorizationRequest, type PreviewRuntime, type PreviewSpec } from 'previewhost';
import { collectSecretIds, REPLAY_NAME_PATTERN } from './ReplayDerivation';

/**
 * Who may start clean copies. The person approves the replays of one recipe for a task, as
 * exactly what they read (its approval digest), in one of two ways: for now, a lease that lives
 * in memory, ends when Task Monki quits and covers a bounded number of environment starts; or
 * kept for the task's repository, which the service turns into a lease without a bound that ends
 * when the person revokes the kept approval. Previewhost asks before every start; only a `br-`
 * name Task Monki is starting right now, with exactly the spec it derived, under a current lease,
 * is approved. Everything else about `br-` names is refused at once, never parked.
 */

export const REPLAY_LEASE_STARTS = 30;

interface ReplayLease {
  startsLeft: number;
  /** The kept approval this lease stands for: it covers every start until that is revoked. */
  keptId?: string;
  grantedAt: string;
}

interface ExpectedStart {
  taskId: string;
  approvalDigest: string;
  spec: PreviewSpec;
  secretIds: string[];
}

export class ReplayAuthorization {
  /** A task's leases, by the approval digest each covers. */
  private readonly leases = new Map<string, Map<string, ReplayLease>>();
  /** Kept approvals revoked while Task Monki runs: a read that raced the revocation grants nothing. */
  private readonly revokedKept = new Set<string>();
  private readonly expected = new Map<string, ExpectedStart>();
  private readonly owned = new Set<string>();

  constructor(private readonly runtime: () => PreviewRuntime) {}

  /** Approves replays of one recipe for the task: for now, or as the kept approval `keptId`. */
  grant(taskId: string, approvalDigest: string, keptId?: string): void {
    if (keptId && this.revokedKept.has(keptId)) return;
    const leases = this.leases.get(taskId) ?? new Map<string, ReplayLease>();
    const current = leases.get(approvalDigest);
    if (current && keptId) current.keptId = keptId;
    else if (current) current.startsLeft += REPLAY_LEASE_STARTS;
    else leases.set(approvalDigest, { startsLeft: keptId ? 0 : REPLAY_LEASE_STARTS, ...(keptId ? { keptId } : {}), grantedAt: new Date().toISOString() });
    this.leases.set(taskId, leases);
  }

  /** Whether the task may start a replay of the recipe with this approval digest now. */
  covers(taskId: string, approvalDigest: string): boolean {
    const lease = this.leases.get(taskId)?.get(approvalDigest);
    return Boolean(lease && (lease.keptId || lease.startsLeft > 0));
  }

  hasLease(taskId: string): boolean {
    return (this.leases.get(taskId)?.size ?? 0) > 0;
  }

  /** A kept approval was revoked: every lease it stood for ends now, not when Task Monki quits. */
  revokeKept(keptId: string): void {
    this.revokedKept.add(keptId);
    for (const [taskId, leases] of this.leases) {
      for (const [digest, lease] of leases) if (lease.keptId === keptId) leases.delete(digest);
      if (leases.size === 0) this.leases.delete(taskId);
    }
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
        const references = [...collectSecretIds(request.spec)];
        if (references.some((id) => !expected.secretIds.includes(id))) return false;
        const lease = this.leases.get(expected.taskId)?.get(expected.approvalDigest);
        if (!lease || (!lease.keptId && lease.startsLeft < 1)) return false;
        if (!lease.keptId) lease.startsLeft -= 1;
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
