import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  secretMounts: Array<{ sourcePath: string; targetPath: string }>;
  binding?: RuntimeManagedResourceBinding;
}

export class PreviewCredentialHost {
  private readonly credentials = new Map<string, HostedResourceCredential>();

  constructor(private readonly root: string) {}

  async create(resourceId: string, resource: PreviewOciResourcePlan): Promise<HostedResourceCredential> {
    if (this.credentials.has(resourceId)) {
      throw new Error(`Runtime credentials already exist for managed resource ${resourceId}.`);
    }
    const directory = path.join(this.root, resourceId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const password = randomBytes(32).toString('base64url');
    const secretMounts: HostedResourceCredential['secretMounts'] = [];
    const containerEnvironment: Record<string, string> = {};
    let username: string | undefined;
    if (resource.type === 'postgres') {
      username = `tm_${randomBytes(8).toString('hex')}`;
      const userPath = await this.writeSecret(directory, 'postgres-user', username);
      const passwordPath = await this.writeSecret(directory, 'postgres-password', password);
      secretMounts.push(
        { sourcePath: userPath, targetPath: '/run/taskmonki/postgres-user' },
        { sourcePath: passwordPath, targetPath: '/run/taskmonki/postgres-password' }
      );
      containerEnvironment.POSTGRES_USER_FILE = '/run/taskmonki/postgres-user';
      containerEnvironment.POSTGRES_PASSWORD_FILE = '/run/taskmonki/postgres-password';
      containerEnvironment.POSTGRES_DB = resource.database;
    } else {
      const passwordPath = await this.writeSecret(directory, 'redis-password', password);
      secretMounts.push({ sourcePath: passwordPath, targetPath: '/run/taskmonki/redis-password' });
    }
    const hosted: HostedResourceCredential = {
      resourceId,
      type: resource.type,
      username,
      password,
      containerEnvironment,
      secretMounts
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

  redactionValues(): string[] {
    return [...new Set([...this.credentials.values()].flatMap((credential) => [
      credential.password,
      encodeURIComponent(credential.password),
      credential.username,
      credential.username ? encodeURIComponent(credential.username) : undefined,
      credential.binding?.postgresUrl,
      credential.binding?.redisUrl
    ]).filter((value): value is string => Boolean(value)))]
      .sort((left, right) => right.length - left.length);
  }

  async delete(resourceId: string): Promise<void> {
    this.credentials.delete(resourceId);
    await fs.rm(path.join(this.root, resourceId), { recursive: true, force: true });
  }

  async clear(): Promise<void> {
    this.credentials.clear();
    await fs.rm(this.root, { recursive: true, force: true });
  }

  private async writeSecret(directory: string, name: string, value: string): Promise<string> {
    const filePath = path.join(directory, name);
    await fs.writeFile(filePath, value, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(filePath, 0o600);
    return filePath;
  }
}
