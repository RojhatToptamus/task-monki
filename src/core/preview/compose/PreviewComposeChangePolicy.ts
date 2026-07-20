import type {
  PreviewComposeChangeKind,
  PreviewComposeInspection,
  PreviewComposeServiceInspection
} from '../../../shared/contracts';

export interface PreviewComposeChangeDecision {
  kind: PreviewComposeChangeKind;
  reasons: string[];
}

export function classifyPreviewComposeChange(
  previous: PreviewComposeInspection | undefined,
  next: PreviewComposeInspection
): PreviewComposeChangeDecision {
  if (!previous) {
    return {
      kind: 'RESTART_PRESERVE_DATA',
      reasons: ['The stable Compose project must be created.']
    };
  }
  const destructive: string[] = [];
  const restart: string[] = [];
  const previousVolumes = new Map(previous.volumes.map((volume) => [volume.name, volume]));
  const nextVolumes = new Map(next.volumes.map((volume) => [volume.name, volume]));
  for (const name of new Set([...previousVolumes.keys(), ...nextVolumes.keys()])) {
    const before = previousVolumes.get(name);
    const after = nextVolumes.get(name);
    if (before && after && (before.driver !== after.driver || before.external !== after.external)) {
      destructive.push(`Volume ${name} changed ownership or driver authority.`);
    } else if (!before || !after) {
      restart.push(`Volume ${name} was ${before ? 'removed' : 'added'}.`);
    }
  }

  const previousServices = new Map(previous.services.map((service) => [service.id, service]));
  const nextServices = new Map(next.services.map((service) => [service.id, service]));
  for (const name of new Set([...previousServices.keys(), ...nextServices.keys()])) {
    const before = previousServices.get(name);
    const after = nextServices.get(name);
    if (!before || !after) {
      restart.push(`Service ${name} was ${before ? 'removed' : 'added'}.`);
      continue;
    }
    const dataBearing = hasWritableData(before) || hasWritableData(after);
    if (dataBearing && dataCompatibilityAuthority(before) !== dataCompatibilityAuthority(after)) {
      destructive.push(`Data-bearing service ${name} changed an unproven compatibility surface.`);
      continue;
    }
    const beforeMounts = new Map(before.namedVolumes.map((mount) => [mount.source, mount]));
    const afterMounts = new Map(after.namedVolumes.map((mount) => [mount.source, mount]));
    for (const source of new Set([...beforeMounts.keys(), ...afterMounts.keys()])) {
      const beforeMount = beforeMounts.get(source);
      const afterMount = afterMounts.get(source);
      if (beforeMount && afterMount && beforeMount.target !== afterMount.target) {
        destructive.push(`Data volume ${source} changed its container layout.`);
      } else if (!beforeMount || !afterMount) {
        restart.push(`Service ${name} changed its named-volume set.`);
      }
    }
    if (destructive.length) continue;
    if (topologyAuthority(before) !== topologyAuthority(after)) {
      restart.push(`Service ${name} changed dependency, network, or volume topology.`);
    }
  }
  if (destructive.length) return { kind: 'DESTRUCTIVE_RESET_REQUIRED', reasons: destructive };
  if (
    restart.length ||
    canonical(previous.networks) !== canonical(next.networks) ||
    previous.trustDigest !== next.trustDigest
  ) {
    return {
      kind: 'RESTART_PRESERVE_DATA',
      reasons: restart.length ? restart : ['Compose trust or network topology changed.']
    };
  }
  return {
    kind: 'IN_PLACE_UPDATE',
    reasons: previous.configDigest === next.configDigest
      ? ['The normalized Compose capability is unchanged.']
      : ['Only stateless service configuration changed.']
  };
}

function hasWritableData(service: PreviewComposeServiceInspection): boolean {
  return service.namedVolumes.some((volume) => !volume.readOnly);
}

function dataCompatibilityAuthority(service: PreviewComposeServiceInspection): string {
  return canonical({
    image: service.image,
    platform: service.platform,
    build: service.build,
    command: service.command,
    entrypoint: service.entrypoint,
    user: service.user,
    workingDirectory: service.workingDirectory,
    secrets: service.secretSources
  });
}

function topologyAuthority(service: PreviewComposeServiceInspection): string {
  return canonical({
    dependsOn: service.dependsOn,
    healthcheck: service.healthcheck,
    networks: service.networks,
    secrets: service.secretSources,
    volumes: service.namedVolumes.map(({ source, target, readOnly }) => ({ source, target, readOnly }))
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
