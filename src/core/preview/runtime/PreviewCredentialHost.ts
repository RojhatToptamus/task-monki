import { randomBytes } from 'node:crypto';
import type { PreviewOciResourcePlan } from '../../../shared/contracts';

export interface RuntimeManagedResourceBinding {
  ports: Record<string, number>;
  postgresUrl?: string;
  redisUrl?: string;
}

export interface HostedResourceCredential {
  resourceId: string;
  type: 'postgres' | 'redis';
  username?: string;
  password: string;
  containerEnvironment: Record<string, string>;
  binding?: RuntimeManagedResourceBinding;
}

export class PreviewCredentialHost {
  private readonly credentials = new Map<string, HostedResourceCredential>();

  async create(resourceId: string, resource: PreviewOciResourcePlan): Promise<HostedResourceCredential> {
    if (this.credentials.has(resourceId)) {
      throw new Error(`Runtime credentials already exist for managed resource ${resourceId}.`);
    }
    const password = randomBytes(32).toString('base64url');
    const containerEnvironment: Record<string, string> = {};
    let username: string | undefined;
    if (resource.type === 'postgres') {
      username = `tm_${randomBytes(8).toString('hex')}`;
      containerEnvironment.POSTGRES_USER = username;
      containerEnvironment.POSTGRES_PASSWORD_FILE = '/dev/stdin';
      containerEnvironment.POSTGRES_DB = resource.database;
    }
    const hosted: HostedResourceCredential = {
      resourceId,
      type: resource.type,
      username,
      password,
      containerEnvironment
    };
    this.credentials.set(resourceId, hosted);
    return hosted;
  }

  require(resourceId: string): HostedResourceCredential {
    const credential = this.credentials.get(resourceId);
    if (!credential) throw new Error(`Runtime credentials are unavailable for managed resource ${resourceId}.`);
    return credential;
  }

  bind(resourceId: string, resource: PreviewOciResourcePlan, ports: Record<string, number>): RuntimeManagedResourceBinding {
    const credential = this.require(resourceId);
    const binding: RuntimeManagedResourceBinding = { ports: { ...ports } };
    if (resource.type === 'postgres') {
      binding.postgresUrl =
        `postgresql://${encodeURIComponent(credential.username!)}:${encodeURIComponent(credential.password)}` +
        `@127.0.0.1:${ports.postgres}/${encodeURIComponent(resource.database)}`;
    } else {
      binding.redisUrl = `redis://:${encodeURIComponent(credential.password)}@127.0.0.1:${ports.redis}/0`;
    }
    credential.binding = binding;
    return binding;
  }

  requireBinding(resourceId: string): RuntimeManagedResourceBinding {
    const binding = this.require(resourceId).binding;
    if (!binding) throw new Error(`Runtime binding is unavailable for managed resource ${resourceId}.`);
    return binding;
  }

  redact(value: string): string {
    let redacted = value;
    for (const credential of this.credentials.values()) {
      for (const secret of [credential.password, credential.username].filter(Boolean) as string[]) {
        redacted = redacted.split(secret).join('[REDACTED]');
        redacted = redacted.split(encodeURIComponent(secret)).join('[REDACTED]');
      }
    }
    return redacted;
  }

  async delete(resourceId: string): Promise<void> {
    this.credentials.delete(resourceId);
  }

  async clear(): Promise<void> {
    this.credentials.clear();
  }
}
