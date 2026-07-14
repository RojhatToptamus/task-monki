import type { OpenPreviewRequest, OpenPreviewResult } from '../../../shared/contracts';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { previewRouteHostname } from '../PreviewRouteHostname';

export interface PreviewUrlHost {
  openExternal(url: string): Promise<void>;
}

export class PreviewOpenService {
  constructor(
    private readonly store: FileTaskStore,
    private readonly host?: PreviewUrlHost
  ) {}

  async open(input: OpenPreviewRequest): Promise<OpenPreviewResult> {
    const generation = await this.store.getPreviewGeneration(input.generationId);
    if (
      !generation ||
      generation.taskId !== input.taskId ||
      generation.state !== 'READY' ||
      generation.routingState !== 'ACTIVE'
    ) {
      throw new Error('Only a recorded ready preview generation can be opened.');
    }
    const route = generation.routes.find(
      (candidate) => candidate.id === input.routeId && candidate.state === 'ATTACHED'
    );
    if (!route) throw new Error('The recorded preview route is not attached.');
    const parsed = new URL(route.url);
    const expectedHostname = previewRouteHostname(generation.taskId, route.id);
    const expectedUrl = `http://${expectedHostname}:${route.gatewayPort}/`;
    if (
      route.url !== expectedUrl ||
      parsed.protocol !== 'http:' ||
      parsed.hostname !== route.hostname ||
      parsed.hostname !== expectedHostname ||
      route.hostname !== expectedHostname ||
      Number(parsed.port) !== route.gatewayPort ||
      parsed.pathname !== '/' ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('Recorded preview route failed the loopback URL safety check.');
    }
    if (this.host) await this.host.openExternal(route.url);
    return { opened: Boolean(this.host), url: route.url };
  }
}
