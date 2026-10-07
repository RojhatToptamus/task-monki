import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createPreviewRuntime,
  loadPreviewSpec,
  resolvePreviewFile,
  savePreviewSpec,
  PreviewError,
  type AuthorizationRequest,
  type PreviewSpec,
  type PreviewRuntime,
  type PreviewStatus,
  type RuntimeOptions
} from 'previewhost';
import type {
  ApplicationPreviewSnapshot,
  ApplicationPreviewApi,
  ApplicationPreviewRecommendation,
  PreviewSecretsApi
} from '../../shared/applicationPreview';
import type { WorktreeRecord } from '../../shared/contracts';
import { canonicalProspectivePath } from './PreviewPaths';
import type { PreviewUrlHost } from '../design/DesignPreviewRoute';

interface Approval {
  attemptId: string;
  approve(): void;
}

/** Task Monki owns consent and worktree selection; Previewhost owns every application resource. */
export class ApplicationPreviewService {
  private runtime?: PreviewRuntime;
  private readonly approvals = new Map<string, Approval>();
  constructor(
    private readonly options: {
      root: string;
      supervisor?: RuntimeOptions['supervisor'];
      openHost?: PreviewUrlHost;
      dockerSocket?: string;
      authorizeDesign?: (spec: PreviewSpec) => Promise<boolean>;
      onApproval?(name: string): Promise<void>;
    }
  ) {}

  async init(): Promise<void> {
    const sources = path.join(this.options.root, 'sources');
    await fs.mkdir(sources, { recursive: true, mode: 0o700 });
    this.runtime = await createPreviewRuntime({
      allowedRoots: [sources],
      stateDirectory: path.join(this.options.root, 'state'),
      dataDirectory: path.join(this.options.root, 'data'),
      keystoreDirectory: path.join(this.options.root, 'secrets'),
      dockerSocket: this.options.dockerSocket,
      supervisor: this.options.supervisor,
      authorize: (request) => this.authorize(request)
    });
  }

  owner(): PreviewRuntime {
    if (!this.runtime)
      throw new Error('Application previews are not initialized.');
    return this.runtime;
  }

  private async authorize(request: AuthorizationRequest): Promise<boolean> {
    // These calls are reachable only through verified worktree selection or explicit trusted controls below.
    if (request.operation !== 'start' && request.operation !== 'replace')
      return true;
    if (await this.options.authorizeDesign?.(request.spec))
      return !request.signal.aborted;
    const runtime = this.owner();
    const status = await runtime.get(request.spec.name);
    const attemptId = status.candidate?.id;
    if (!attemptId || request.signal.aborted) return false;
    let cancel!: () => void;
    const decision = new Promise<boolean>((resolve) => {
      const finish = (allowed: boolean) => {
        request.signal.removeEventListener('abort', canceled);
        if (this.approvals.get(request.spec.name)?.attemptId === attemptId)
          this.approvals.delete(request.spec.name);
        resolve(allowed);
      };
      const canceled = () => finish(false);
      cancel = canceled;
      this.approvals.set(request.spec.name, {
        attemptId,
        approve: () => finish(true)
      });
      request.signal.addEventListener('abort', canceled, { once: true });
      if (request.signal.aborted) canceled();
    });
    let approved: boolean;
    try {
      await this.options.onApproval?.(request.spec.name);
      approved = await decision;
    } catch (error) {
      cancel();
      throw error;
    }
    if (!approved || request.signal.aborted) return false;
    const setup = await runtime.prepareSecretSetup(
      request.spec,
      request.signal
    );
    await setup.approve?.(request.signal);
    return !request.signal.aborted;
  }

  name(worktree: Pick<WorktreeRecord, 'id'>): string {
    return `tm-${worktree.id}`;
  }

  async allowWorktree(worktree: WorktreeRecord): Promise<void> {
    await this.owner().allowSources([worktree.worktreePath], new AbortController().signal);
  }

  hasPendingApproval(name: string): boolean {
    return this.approvals.has(name);
  }

  async read(worktree: WorktreeRecord): Promise<ApplicationPreviewSnapshot> {
    const name = this.name(worktree);
    let status: PreviewStatus | undefined;
    try {
      status = await this.owner().get(name);
    } catch (error) {
      if (!(error instanceof PreviewError && error.code === 'NOT_FOUND'))
        throw error;
    }
    const configurationFiles = await Promise.all(
      ['preview.yaml', 'preview.yml'].map((name) =>
        fs.lstat(path.join(worktree.worktreePath, name)).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          }
        )
      )
    );
    const approval = this.approvals.get(name);
    let fileSources: ApplicationPreviewSnapshot['fileSources'];
    let configurationError: string | undefined;
    if (configurationFiles.some(Boolean) && (!status?.latest || status.latest.error?.code === 'SOURCE_DENIED')) {
      try {
        const spec = await loadPreviewSpec(await resolvePreviewFile(worktree.worktreePath), { allowedRoots: [worktree.worktreePath] });
        fileSources = await this.sources(spec, worktree.worktreePath);
      } catch (error) { configurationError = error instanceof Error ? error.message : 'Cannot read preview.yaml.'; }
    }
    return {
      name,
      fileSources,
      configurationError,
      hasConfigurationFile: configurationFiles.some(Boolean),
      status,
      ...(approval
        ? {
            approval: {
              attemptId: approval.attemptId,
              description: await this.owner().describe(name, approval.attemptId),
              secrets: await this.secretAvailability(name, approval.attemptId)
            }
          }
        : {})
    };
  }

  async start(
    worktree: WorktreeRecord,
    source: 'file' | 'retained'
  ): Promise<ApplicationPreviewSnapshot> {
    const runtime = this.owner();
    await this.allowWorktree(worktree);
    const current = await this.read(worktree);
    if (source === 'retained') {
      if (!current.status?.latest)
        throw new Error(
          'No retained preview configuration exists. Load preview.yaml first.'
        );
      await runtime.startAgain(current.name, current.status.latest.id);
    } else {
      const file = await resolvePreviewFile(worktree.worktreePath);
      const spec = await loadPreviewSpec(file, {
        allowedRoots: runtime.sourceRoots()
      });
      spec.name = current.name;
      const options = { sourceFile: file, expected: expected(current.status) };
      if (current.status?.active)
        await runtime.replace(current.name, spec, options);
      else await runtime.start(spec, options);
    }
    return this.read(worktree);
  }

  async createConfiguration(
    worktree: WorktreeRecord,
    input: Parameters<
      ApplicationPreviewApi['createApplicationPreviewConfiguration']
    >[0]
  ): Promise<ApplicationPreviewSnapshot> {
    if (input.type !== 'static' && input.type !== 'command')
      throw new Error('Select a static site or development command.');
    if (typeof input.directory !== 'string' || path.isAbsolute(input.directory))
      throw new Error('Use a folder relative to this worktree.');
    const root = await fs.realpath(worktree.worktreePath);
    const directory = await fs.realpath(path.resolve(root, input.directory));
    const relative = path.relative(root, directory);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error('Choose a folder inside this worktree.');
    if (
      input.type === 'command' &&
      (typeof input.command !== 'string' ||
        !input.command.trim() ||
        input.command.length > 8192)
    )
      throw new Error('Enter a development command.');
    const runtime = this.owner();
    const current = await this.read(worktree);
    if (
      current.status?.latest ||
      current.status?.candidate ||
      current.hasConfigurationFile
    )
      throw new Error(
        'A preview configuration already exists. Reload Preview before editing it.'
      );
    await runtime.allowSources([root], new AbortController().signal);
    const spec: PreviewSpec =
      input.type === 'static'
        ? { name: current.name, type: 'static', directory }
        : {
            name: current.name,
            type: 'command',
            cwd: directory,
            command:
              process.platform === 'win32'
                ? ['cmd.exe', '/d', '/s', '/c', input.command!]
                : ['/bin/sh', '-lc', input.command!]
          };
    await savePreviewSpec(spec, { projectDirectory: root, allowedRoots: [root] });
    return this.read(worktree);
  }

  private async secretAvailability(name: string, attemptId: string): Promise<NonNullable<ApplicationPreviewSnapshot['approval']>['secrets']> {
    const requirements = (await this.owner().describe(name, attemptId)).secrets ?? [];
    if (!requirements.length) return [];
    const vault = this.owner().keystore;
    try {
      const status = await vault.status();
      return await Promise.all(requirements.map(async requirement => ({
        ...requirement,
        availability: status.state !== 'unlocked' ? 'locked' as const : await vault.has('user', requirement.id) ? 'available' as const : 'missing' as const
      })));
    } catch { return requirements.map(requirement => ({ ...requirement, availability: 'unavailable' })); }
  }

  async inspectSetup(worktree: WorktreeRecord) {
    const projectDirectory = await fs.realpath(worktree.worktreePath);
    const recommendations: ApplicationPreviewRecommendation[] = [];
    for (const directory of ['.', 'web', 'client', 'frontend', 'app', 'apps/web']) {
      const folder = path.resolve(projectDirectory, directory);
      const canonical = await fs.realpath(folder).catch(() => undefined);
      if (!canonical || !within(projectDirectory, canonical)) continue;
      let manifest: { scripts?: Record<string, string> } | undefined;
      try {
        const info = await fs.stat(path.join(canonical, 'package.json'));
        if (info.size <= 1_048_576) manifest = JSON.parse(await fs.readFile(path.join(canonical, 'package.json'), 'utf8'));
      } catch { /* Missing or invalid manifests do not prevent manual setup. */ }
      const script = manifest?.scripts?.dev;
      const manager = await fs.access(path.join(canonical, 'pnpm-lock.yaml')).then(() => 'pnpm', () => fs.access(path.join(canonical, 'yarn.lock')).then(() => 'yarn', () => 'npm'));
      if (typeof script === 'string' && /^(vite|next dev)(?:\s|$)/.test(script.trim())) {
        const vite = script.trim().startsWith('vite');
        recommendations.push({ type: 'command', directory, command: `${manager} run dev${manager === 'yarn' ? '' : ' --'} ${vite ? '--host 127.0.0.1 --port "$PORT" --strictPort' : '--hostname 127.0.0.1 --port "$PORT"'}`,
          explanation: `Detected ${vite ? 'Vite' : 'Next.js'} in ${directory}. Runs the project's dev script on a private local port. Project dependencies must be installed first.` });
      } else if (!manifest && await fs.access(path.join(canonical, 'index.html')).then(() => true, () => false)) {
        recommendations.push({ type: 'static', directory, explanation: `Serve index.html and files in ${directory === '.' ? 'the project folder' : directory}. No development command or dependency installation is needed.` });
      }
    }
    return { projectDirectory, recommendations };
  }

  private async sources(spec: PreviewSpec, worktreePath: string) {
    const roots = [...this.owner().sourceRoots(), await fs.realpath(worktreePath)];
    const entries = spec.type === 'environment' ? Object.entries(spec.services) : [['Application', spec] as const];
    const sources: NonNullable<ApplicationPreviewSnapshot['fileSources']> = [];
    for (const [service, value] of entries) {
      const directory = 'cwd' in value ? value.cwd : 'directory' in value ? value.directory : undefined;
      if (directory) {
        const canonical = await fs.realpath(directory);
        sources.push({ service, directory: canonical, connected: roots.some(root => within(root, canonical)) });
      }
      const probes = [
        ['readiness', 'ready' in value ? value.ready : undefined],
        ['liveness', 'liveness' in value ? value.liveness?.probe : undefined]
      ] as const;
      for (const [kind, probe] of probes) {
        if (probe?.type !== 'command' || !probe.cwd) continue;
        const canonical = await fs.realpath(probe.cwd);
        sources.push({ service: `${service} ${kind}`, directory: canonical, connected: roots.some(root => within(root, canonical)) });
      }
    }
    return sources;
  }

  async connectSource(worktree: WorktreeRecord, input: Parameters<ApplicationPreviewApi['connectApplicationPreviewSource']>[0]) {
    const runtime = this.owner();
    if (!path.isAbsolute(input.directory)) throw new Error('Choose an absolute source folder.');
    const directory = await fs.realpath(input.directory);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('Choose an existing folder.');
    const current = await this.read(worktree);
    if ((['active', 'candidate', 'latest'] as const).some(key => expected(current.status)[key] !== input.expected[key])) throw new Error('Preview changed. Review the current configuration before connecting.');
    if (!input.attemptId) {
      if (!current.fileSources?.some(source => source.service === input.service && source.directory === directory)) throw new Error('The configuration changed. Review its source folders again.');
    } else {
      const description = await runtime.describe(current.name, input.attemptId);
      const value = description.spec.type === 'environment' ? input.service && description.spec.services[input.service] : input.service === undefined ? description.spec : undefined;
      if (!value || !['static', 'command', 'worker', 'job', 'compose'].includes(value.type)) throw new Error('This service does not use a source folder.');
      if (current.status?.candidate || ![current.status?.active?.id, current.status?.latest?.id].includes(input.attemptId)) throw new Error('Preview changed. Review the current configuration before connecting.');
    }
    const alreadyConnected = runtime.sourceRoots().some(root => within(root, directory));
    await runtime.allowSources([directory], new AbortController().signal);
    try {
      if (input.attemptId) await runtime.configureSource(current.name, input.attemptId, input.service, directory, input.expected);
    } catch (error) {
      // A concurrent preview may now use the explicitly connected folder. Never revoke its access.
      if (!alreadyConnected) {
        try { runtime.releaseSources([directory]); } catch { /* The runtime retains shared or live roots. */ }
      }
      throw error;
    }
    return this.read(worktree);
  }

  async approve(worktree: WorktreeRecord, attemptId: string): Promise<void> {
    const approval = this.approvals.get(this.name(worktree));
    if (!approval || approval.attemptId !== attemptId)
      throw new Error('This approval is no longer current.');
    const secrets = await this.secretAvailability(this.name(worktree), attemptId);
    const blocked = secrets.filter(secret => secret.availability !== 'available');
    if (blocked.length) throw new Error(`Resolve these secrets before approving: ${blocked.map(secret => `${secret.id} (${secret.availability})`).join(', ')}.`);
    if (this.approvals.get(this.name(worktree)) !== approval) throw new Error('This approval is no longer current.');
    approval.approve();
  }

  async open(worktree: WorktreeRecord, attemptId: string, service?: string) {
    const status = await this.owner().get(this.name(worktree));
    if (status.active?.id !== attemptId || !status.url)
      throw new Error('Only the currently serving application can be opened.');
    const url = service
      ? status.active.services?.[service]?.browserUrl
      : status.url;
    if (!url) throw new Error('This service has no browser endpoint.');
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'http:' ||
      (parsed.hostname !== '127.0.0.1' &&
        !parsed.hostname.endsWith('.localhost')) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/' ||
      parsed.port !== new URL(status.url).port
    ) {
      throw new Error(
        'The application endpoint failed the loopback safety check.'
      );
    }
    await this.options.openHost?.openExternal(url);
    return { url, opened: !!this.options.openHost };
  }

  async retireWorktree(worktree: WorktreeRecord): Promise<void> {
    const { status, name } = await this.read(worktree);
    if (!status) {
      this.owner().releaseSources([
        await canonicalProspectivePath(worktree.worktreePath)
      ]);
      return;
    }
    const stopped = await this.owner().stop(name);
    if (stopped.data)
      throw new Error(
        'Delete this worktree’s retained data in Preview before deleting its task.'
      );
    this.owner().releaseSources([
      await canonicalProspectivePath(worktree.worktreePath)
    ]);
    await this.owner().remove(name, stopped.latest?.id ?? null);
  }

  async close(): Promise<void> {
    await this.runtime?.close();
  }

  readonly secrets: PreviewSecretsApi = {
    has: ({ id }) => this.owner().keystore.has('user', id),
    status: () => this.owner().keystore.status(),
    list: async (input) => {
      const runtime = this.owner();
      const page = await runtime.keystore.list(input);
      const usage: Record<string, string[]> = {};
      for (const status of await runtime.list()) {
        const attempts = [status.active, status.latest].filter(
          (attempt, index, all) =>
            attempt &&
            all.findIndex((value) => value?.id === attempt.id) === index
        );
        for (const attempt of attempts) {
          if (!attempt) continue;
          const description = await runtime.describe(status.name, attempt.id);
          for (const reference of description.secrets ?? []) {
            if (page.ids.includes(reference.id))
              usage[reference.id] = [
                ...new Set([...(usage[reference.id] ?? []), ...attempt.sources])
              ];
          }
        }
      }
      return { ...page, usage };
    },
    unlock: (input) => this.owner().keystore.unlock(input),
    lock: async () => {
      this.owner().keystore.lock();
    },
    remember: () => this.owner().keystore.remember(),
    forget: () => this.owner().keystore.forget(),
    create: async ({ id, value }) => {
      if (!(await this.owner().keystore.add('user', id, value)))
        throw new Error(
          'This secret reference already exists. Use Edit to replace its value.'
        );
    },
    update: ({ id, value }) => this.owner().keystore.update('user', id, value),
    remove: async ({ id }) => {
      await this.owner().keystore.remove('user', id);
    }
  };
}

function expected(status?: PreviewStatus) {
  return {
    active: status?.active?.id ?? null,
    candidate: status?.candidate?.id ?? null,
    latest: status?.latest?.id ?? null
  };
}

function within(root: string, directory: string) {
  const relative = path.relative(root, directory);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
