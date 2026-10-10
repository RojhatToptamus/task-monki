import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  createPreviewRuntime,
  parsePreviewSpec,
  PreviewError,
  type AuthorizationRequest,
  type PreviewSpec,
  type PreviewRuntime,
  type PreviewStatus,
  type PreviewDescription,
  type SecretRequirement,
  type RuntimeOptions
} from 'previewhost';
import type {
  ApplicationPreviewSnapshot,
  PreviewConfigurationFile,
  PreviewRequirements,
  ApplicationPreviewApi,
  ApplicationPreviewRecommendation,
  PreviewSecretsApi
} from '../../shared/applicationPreview';
import type { WorktreeRecord } from '../../shared/contracts';
import { canonicalProspectivePath } from './PreviewPaths';
import {
  readPreviewRecipeFile,
  readPreviewRecipeFiles,
  writeReviewedPreviewRecipe
} from './generation/PreviewRecipeFile';
import {
  resolveConfigurationSources,
  missingConnections,
  within,
  reconcileRetainedConfiguration
} from './ApplicationPreviewConfiguration';
import { diagnosePreviewFailure } from './ApplicationPreviewDiagnosis';
import { validatePreviewRecipeDraft } from './generation/PreviewRecipeGenerationService';
import { readPreviewProjectFacts } from './PreviewProjectFacts';
import type { PreviewUrlHost } from '../design/DesignPreviewRoute';

interface Approval {
  attemptId: string;
  spec: PreviewSpec;
  approve(): void;
}

interface SubmittedConfiguration {
  file: PreviewConfigurationFile;
  spec: PreviewSpec;
}
interface RestartReview extends SubmittedConfiguration {
  id: string;
  description: PreviewDescription;
  expected: ReturnType<typeof expected>;
  affected: NonNullable<
    ApplicationPreviewSnapshot['restartReview']
  >['affected'];
  approved: boolean;
}

/** Task Monki owns consent and worktree selection; Previewhost owns every application resource. */
export class ApplicationPreviewService {
  private runtime?: PreviewRuntime;
  private readonly submitted = new Map<string, SubmittedConfiguration>();
  private readonly restartReviews = new Map<string, RestartReview>();
  private readonly sourceLocations = new Map<
    string,
    Map<string, { path: string; canonical: string }>
  >();
  private readonly approvals = new Map<string, Approval>();
  constructor(
    private readonly options: {
      root: string;
      supervisor?: RuntimeOptions['supervisor'];
      openHost?: PreviewUrlHost;
      dockerSocket?: string;
      repositoryPath?(worktree: WorktreeRecord): Promise<string>;
      previewTitle?(name: string): Promise<string>;
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
    const restart = this.restartReviews.get(request.spec.name);
    if (restart?.approved) {
      // Consume even on mismatch. A changed candidate always gets ordinary approval.
      this.restartReviews.delete(request.spec.name);
      if (isDeepStrictEqual(request.spec, parsePreviewSpec(restart.spec))) {
        const setup = await runtime.prepareSecretSetup(
          request.spec,
          request.signal
        );
        await setup.approve?.(request.signal);
        return !request.signal.aborted;
      }
    }
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
        spec: structuredClone(request.spec),
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
    await this.owner().allowSources(
      [worktree.worktreePath],
      new AbortController().signal
    );
  }

  hasPendingApproval(name: string): boolean {
    return this.approvals.has(name) || this.restartReviews.has(name);
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
    const alive = new Set(
      (await this.owner().list())
        .flatMap((item) => [
          item.active?.id,
          item.latest?.id,
          item.candidate?.id
        ])
        .filter(Boolean)
    );
    for (const id of this.submitted.keys())
      if (!alive.has(id)) this.submitted.delete(id);
    const record = this.submitted.get(
      (status?.active ?? status?.latest)?.id ?? ''
    );
    let file: PreviewConfigurationFile | undefined;
    let hasConfigurationFile = false;
    let requirements: PreviewRequirements | undefined;
    let configurationError: string | undefined;
    try {
      hasConfigurationFile = (
        await Promise.all(
          ['preview.yaml', 'preview.yml'].map((fileName) =>
            fs.lstat(path.join(worktree.worktreePath, fileName)).then(
              () => true,
              () => false
            )
          )
        )
      ).some(Boolean);
      file = await readPreviewRecipeFile(worktree.worktreePath);
      if (file) {
        const resolved = await this.resolve(worktree, file);
        requirements = {
          sources: resolved.sources,
          connections: missingConnections(resolved.spec),
          secrets: await this.availability(secretReferences(resolved.spec))
        };
        const databases = managedDatabases(resolved.spec);
        if (databases.length)
          requirements.storage = {
            services: databases,
            state: (await this.owner().keystore.status()).state
          };
        if (resolved.sources.every((source) => source.connected)) {
          await this.allowWorktree(worktree);
          requirements.description = await this.owner().inspect(resolved.spec);
        }
      }
    } catch (error) {
      configurationError =
        error instanceof Error ? error.message : 'Cannot read preview.yaml.';
    }
    const approval = this.approvals.get(name);
    const restart = this.restartReviews.get(name);
    const reviewedSpec = restart?.spec ?? approval?.spec;
    if (reviewedSpec) {
      // An open approval belongs to its captured candidate, even if the file changes.
      const databases = managedDatabases(reviewedSpec);
      requirements = {
        sources: [],
        connections: [],
        secrets: await this.availability(secretReferences(reviewedSpec)),
        description:
          restart?.description ??
          (await this.owner().describe(name, approval!.attemptId)),
        ...(databases.length
          ? {
              storage: {
                services: databases,
                state: (await this.owner().keystore.status()).state
              }
            }
          : {})
      };
    }
    const latest = status?.candidate ?? status?.latest;
    const diagnosis =
      latest?.state === 'failed'
        ? await diagnosePreviewFailure(
            this.owner(),
            name,
            status!,
            requirements?.description
          )
        : undefined;
    return {
      name,
      status,
      projectDirectory: await canonicalProspectivePath(worktree.worktreePath),
      hasConfigurationFile,
      configurationError,
      requirements,
      diagnosis,
      fileSources: requirements?.sources,
      configurationChanged:
        !!file &&
        !!record &&
        (file.name !== record.file.name || file.text !== record.file.text),
      canRestore: !file && !!record,
      restoredRun: !!status?.latest && !this.submitted.has(status.latest.id),
      ...(restart && !restart.approved
        ? {
            restartReview: {
              id: restart.id,
              description: restart.description,
              affected: restart.affected
            }
          }
        : {}),
      ...(approval
        ? {
            approval: {
              attemptId: approval.attemptId,
              description: await this.owner().describe(
                name,
                approval.attemptId
              ),
              secrets: await this.secretAvailability(name, approval.attemptId),
              affected: await this.liveFolderJobs(approval.spec, name)
            }
          }
        : {})
    };
  }

  private async resolve(
    worktree: WorktreeRecord,
    file: PreviewConfigurationFile
  ) {
    const resolved = await resolveConfigurationSources(
      file,
      worktree.worktreePath,
      (await this.options.repositoryPath?.(worktree)) ?? worktree.worktreePath,
      this.owner().sourceRoots(),
      this.sourceLocations.get(worktree.repositoryId) ?? new Map()
    );
    resolved.spec.name = this.name(worktree);
    return resolved;
  }

  async readFile(worktree: WorktreeRecord) {
    const name = this.name(worktree);
    const status = await this.owner()
      .get(name)
      .catch((error) => {
        if (error instanceof PreviewError && error.code === 'NOT_FOUND')
          return undefined;
        throw error;
      });
    const previous = this.submitted.get(
      (status?.active ?? status?.latest)?.id ?? ''
    )?.file;
    const files = await readPreviewRecipeFiles(worktree.worktreePath);
    const retained = status?.active ?? status?.latest;
    const reconciliation =
      files.length === 1 && retained && !this.submitted.has(retained.id)
        ? reconcileRetainedConfiguration(
            files[0]!,
            await this.owner().describe(name, retained.id)
          )
        : undefined;
    return files.length > 1
      ? { files, previous }
      : { file: files[0], previous, reconciliation };
  }

  async saveFile(
    worktree: WorktreeRecord,
    original: PreviewConfigurationFile | undefined,
    text: string
  ) {
    // Every route that writes the file meets the same contract as an agent proposal: Previewhost's
    // strict loader, no secret-like literals or concealment placeholders, no fromEnv inputs.
    const validation = validatePreviewRecipeDraft(text);
    if (validation.status !== 'VALID')
      throw new Error(validation.issues.map((issue) => issue.message).join(' '));
    await writeReviewedPreviewRecipe(worktree.worktreePath, text, original);
    return this.read(worktree);
  }

  async chooseFile(
    worktree: WorktreeRecord,
    keep: PreviewConfigurationFile['name'],
    files: PreviewConfigurationFile[]
  ) {
    const current = await this.readFile(worktree);
    if (
      !current.files ||
      !isDeepStrictEqual(current.files, files) ||
      !files.some((file) => file.name === keep)
    )
      throw new Error('Configuration changed. Reload before choosing a file.');
    const other = keep === 'preview.yaml' ? 'preview.yml' : 'preview.yaml';
    const source = path.join(worktree.worktreePath, other);
    // Exclusive creation also protects an existing .unused backup.
    await fs.link(source, source + '.unused');
    await fs.unlink(source);
    return this.read(worktree);
  }

  async start(worktree: WorktreeRecord): Promise<ApplicationPreviewSnapshot> {
    const runtime = this.owner();
    const name = this.name(worktree);
    if (this.restartReviews.has(name))
      throw new Error('Finish or cancel the open restart review first.');
    await this.allowWorktree(worktree);
    const current = await this.read(worktree);
    const file = await readPreviewRecipeFile(worktree.worktreePath);
    if (!file)
      throw new Error(
        'No preview.yaml found. Draft a configuration with the Preview agent.'
      );
    const { spec, sources } = await this.resolve(worktree, file);
    if (sources.some((source) => !source.connected))
      throw new Error('Connect the listed source folders before starting.');
    if (missingConnections(spec).length)
      throw new Error(
        `Connect these services in Configuration: ${missingConnections(spec).join(', ')}.`
      );
    const description = await runtime.inspect(spec);
    const affected = await this.liveFolderJobs(spec, name);
    if (current.status?.active && affected.length) {
      this.restartReviews.set(name, {
        id: randomUUID(),
        file,
        spec: structuredClone(spec),
        description,
        expected: expected(current.status),
        affected,
        approved: false
      });
      return this.read(worktree);
    }
    const options = {
      sourceFile: path.join(worktree.worktreePath, file.name),
      expected: expected(current.status)
    };
    const started = current.status?.active
      ? await runtime.replace(name, spec, options)
      : await runtime.start(spec, options);
    const id = started.candidate?.id ?? started.latest?.id;
    if (id) this.submitted.set(id, { file, spec: structuredClone(spec) });
    return this.read(worktree);
  }

  private async liveFolderJobs(spec: PreviewSpec, name: string) {
    const runtime = this.owner();
    const affected: RestartReview['affected'] = [];
    if (spec.type === 'environment') {
      const live = (await runtime.list()).filter((preview) => preview.active);
      for (const [job, service] of Object.entries(spec.services)) {
        if (service.type !== 'job') continue;
        const consumers = live.filter((preview) =>
          preview.active!.sources.some(
            (source) =>
              within(source, service.cwd) || within(service.cwd, source)
          )
        );
        if (consumers.length)
          affected.push({
            job,
            directory: service.cwd,
            previews: await Promise.all(
              consumers.map(
                (preview) =>
                  this.options.previewTitle?.(preview.name) ??
                  Promise.resolve(
                    preview.name === name ? 'this preview' : 'another preview'
                  )
              )
            )
          });
      }
    }
    return affected;
  }

  async startRetained(worktree: WorktreeRecord) {
    if (await readPreviewRecipeFile(worktree.worktreePath))
      throw new Error('preview.yaml exists. Start from the current file.');
    await this.allowWorktree(worktree);
    const current = await this.read(worktree);
    if (!current.status?.latest)
      throw new Error('There is no previous configuration to start.');
    await this.owner().startAgain(current.name, current.status.latest.id);
    return this.read(worktree);
  }

  async cancel(worktree: WorktreeRecord, id: string) {
    const name = this.name(worktree);
    const restart = this.restartReviews.get(name);
    if (restart?.id === id && !restart.approved)
      this.restartReviews.delete(name);
    else await this.owner().cancel(name, id);
    return this.read(worktree);
  }

  private async secretAvailability(
    name: string,
    attemptId: string
  ): Promise<NonNullable<ApplicationPreviewSnapshot['approval']>['secrets']> {
    return this.availability(
      (await this.owner().describe(name, attemptId)).secrets ?? []
    );
  }

  private async availability(
    requirements: SecretRequirement[]
  ): Promise<NonNullable<ApplicationPreviewSnapshot['approval']>['secrets']> {
    if (!requirements.length) return [];
    const vault = this.owner().keystore;
    try {
      const status = await vault.status();
      return await Promise.all(
        requirements.map(async (requirement) => ({
          ...requirement,
          availability:
            status.state !== 'unlocked'
              ? status.state
              : (await vault.has('user', requirement.id))
                ? ('available' as const)
                : ('missing' as const)
        }))
      );
    } catch {
      return requirements.map((requirement) => ({
        ...requirement,
        availability: 'unavailable'
      }));
    }
  }

  async inspectSetup(worktree: WorktreeRecord) {
    const projectDirectory = await fs.realpath(worktree.worktreePath);
    const recommendations: ApplicationPreviewRecommendation[] = [];
    for (const directory of [
      '.',
      'web',
      'client',
      'frontend',
      'app',
      'apps/web'
    ]) {
      const folder = path.resolve(projectDirectory, directory);
      const canonical = await fs.realpath(folder).catch(() => undefined);
      if (!canonical || !within(projectDirectory, canonical)) continue;
      let hasManifest = false;
      for (
        let ancestor = canonical;
        within(projectDirectory, ancestor);
        ancestor = path.dirname(ancestor)
      ) {
        if (
          await fs.lstat(path.join(ancestor, 'package.json')).then(
            () => true,
            () => false
          )
        ) {
          hasManifest = true;
          break;
        }
        if (ancestor === projectDirectory) break;
      }
      if (
        !hasManifest &&
        (await fs.access(path.join(canonical, 'index.html')).then(
          () => true,
          () => false
        ))
      ) {
        recommendations.push({
          type: 'static',
          directory,
          explanation: `Serve index.html and files in ${directory === '.' ? 'the project folder' : directory}. No development command or dependency installation is needed.`
        });
      }
    }
    return { projectDirectory, recommendations, facts: await readPreviewProjectFacts(projectDirectory) };
  }

  async connectSource(
    worktree: WorktreeRecord,
    input: Parameters<
      ApplicationPreviewApi['connectApplicationPreviewSource']
    >[0]
  ) {
    const runtime = this.owner();
    if (!path.isAbsolute(input.directory))
      throw new Error('Choose an absolute source folder.');
    const directory = await fs.realpath(input.directory);
    if (!(await fs.stat(directory)).isDirectory())
      throw new Error('Choose an existing folder.');
    const privateRoot = await fs.realpath(this.options.root);
    if (within(privateRoot, directory) || within(directory, privateRoot))
      throw new Error(
        'Preview private storage cannot be connected as a project folder.'
      );
    const current = await this.read(worktree);
    if (!isDeepStrictEqual(expected(current.status), input.expected))
      throw new Error(
        'Preview changed. Review the current configuration before connecting.'
      );
    const source = current.fileSources?.find(
      (source) => source.service === input.service
    );
    if (
      !source ||
      (!source.missing && (await fs.realpath(source.directory)) !== directory)
    )
      throw new Error(
        'The configuration changed. Review its source folders again.'
      );
    await runtime.allowSources([directory], new AbortController().signal);
    const locations =
      this.sourceLocations.get(worktree.repositoryId) ?? new Map();
    locations.set(source.declaration, {
      path: input.directory,
      canonical: directory
    });
    this.sourceLocations.set(worktree.repositoryId, locations);
    return this.read(worktree);
  }

  async approve(worktree: WorktreeRecord, attemptId: string): Promise<void> {
    const name = this.name(worktree);
    const restart = this.restartReviews.get(name);
    if (restart?.id === attemptId && !restart.approved) {
      const resolved = await this.resolve(worktree, restart.file);
      if (
        resolved.sources.some((source) => !source.connected) ||
        !isDeepStrictEqual(
          parsePreviewSpec(resolved.spec),
          parsePreviewSpec(restart.spec)
        )
      ) {
        this.restartReviews.delete(name);
        throw new Error(
          'A source folder changed since this review. Review its connection and start again. The running preview has not been stopped.'
        );
      }
      const secrets = await this.availability(secretReferences(restart.spec));
      if (secrets.some((secret) => secret.availability !== 'available'))
        throw new Error(
          'Resolve the required secrets before approving this restart.'
        );
      await this.assertDatabaseStorageReady(restart.spec);
      restart.approved = true;
      let stopped = false;
      try {
        const status = await this.owner().stop(name, {
          expected: restart.expected
        });
        stopped = true;
        const started = await this.owner().start(
          structuredClone(restart.spec),
          {
            sourceFile: path.join(worktree.worktreePath, restart.file.name),
            expected: expected(status)
          }
        );
        const id = started.candidate?.id ?? started.latest?.id;
        if (id)
          this.submitted.set(id, { file: restart.file, spec: restart.spec });
      } catch (error) {
        this.restartReviews.delete(name);
        const detail =
          error instanceof Error ? error.message : 'Unknown runtime error.';
        throw new Error(
          stopped
            ? `The previous preview stopped, but its replacement could not start. ${detail} Resolve the reported requirement, then choose Start preview.`
            : `Preview could not stop for this restart. ${detail} Review its current status before retrying.`,
          { cause: error }
        );
      }
      return;
    }
    const approval = this.approvals.get(name);
    if (!approval || approval.attemptId !== attemptId)
      throw new Error('This approval is no longer current.');
    const status = await this.owner().get(name);
    const attempt = [status.candidate, status.latest].find(
      (value) => value?.id === attemptId
    );
    for (const source of attempt?.sources ?? []) {
      if ((await fs.realpath(source).catch(() => undefined)) !== source)
        throw new Error(
          'A source folder changed since this review. Cancel this attempt, reconnect the folder, and start again.'
        );
    }
    const secrets = await this.secretAvailability(
      this.name(worktree),
      attemptId
    );
    const blocked = secrets.filter(
      (secret) => secret.availability !== 'available'
    );
    if (blocked.length)
      throw new Error(
        `Resolve these secrets before approving: ${blocked.map((secret) => `${secret.id} (${secret.availability})`).join(', ')}.`
      );
    if (this.approvals.get(this.name(worktree)) !== approval)
      throw new Error('This approval is no longer current.');
    await this.assertDatabaseStorageReady(approval.spec);
    approval.approve();
  }

  private async assertDatabaseStorageReady(spec: PreviewSpec): Promise<void> {
    if (
      managedDatabases(spec).length &&
      (await this.owner().keystore.status()).state !== 'unlocked'
    )
      throw new Error(
        'Unlock secret storage before approving database startup.'
      );
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
    this.restartReviews.clear();
    this.submitted.clear();
    this.sourceLocations.clear();
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

function secretReferences(spec: PreviewSpec): SecretRequirement[] {
  const result = new Map<string, SecretRequirement>();
  const visit = (value: unknown, service?: string, key = '') => {
    if (!value || typeof value !== 'object') return;
    if ('secret' in value && typeof value.secret === 'string') {
      const row = result.get(value.secret) ?? {
        id: value.secret,
        selected: false,
        bindings: []
      };
      row.bindings.push({ service, key });
      result.set(row.id, row);
      return;
    }
    for (const [child, entry] of Object.entries(value))
      visit(entry, service, child);
  };
  if (spec.type === 'environment')
    for (const [service, node] of Object.entries(spec.services))
      visit(node, service);
  else visit(spec);
  return [...result.values()];
}

function managedDatabases(spec: PreviewSpec): string[] {
  return spec.type === 'environment'
    ? Object.entries(spec.services)
        .filter(([, node]) => node.type === 'postgres' || node.type === 'redis')
        .map(([id]) => id)
    : [];
}
