import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PreviewGatewayBrowserLease } from '../preview/PreviewGateway';
import { execFileOwnedPortable } from '../process/ownedProcess';

const MARKER_FILE = '.task-monki-design-browser.json';
const MARKER_VERSION = 1 as const;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_RUN_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_RUN_SCREENSHOTS = 64;
const COMMAND_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 45_000;
const REF = /^@e[1-9][0-9]{0,4}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AGENT_BROWSER_VERSION = '0.34.0';
const AGENT_BROWSER_COMMIT = '548b159b30eef119ccf6846c8bc807d0eaa3f6f8';
const CHROME_VERSION = '152.0.7977.54';
const AGENT_BROWSER_SHA256: Partial<Record<NodeJS.Architecture, string>> = {
  arm64: 'd680a7a96ab86e9ab9d2b571b12919b761e93682ad1de714bbd5ac849c8d7c9c',
  x64: 'dad3c9f9e67791a44a768a98847510c61a7b568a0499c602632b8aee411101e7'
};

export type InspectDesignOperation =
  | { operation: 'open_candidate' }
  | { operation: 'observe' }
  | {
      operation: 'act';
      action:
        | 'click'
        | 'double_click'
        | 'hover'
        | 'focus'
        | 'fill'
        | 'type'
        | 'key'
        | 'select'
        | 'check'
        | 'uncheck'
        | 'scroll'
        | 'scroll_into_view'
        | 'drag'
        | 'wait';
      ref?: string;
      targetRef?: string;
      value?: string;
      values?: string[];
      direction?: 'up' | 'down' | 'left' | 'right';
      amount?: number;
      milliseconds?: number;
    }
  | { operation: 'set_viewport'; width: number; height: number }
  | {
      operation: 'set_media';
      colorScheme: 'light' | 'dark';
      reducedMotion: boolean;
    }
  | { operation: 'screenshot'; ref?: string; fullPage?: boolean }
  | { operation: 'accessibility' };

export interface DesignBrowserObservation {
  snapshot: string;
  console: string;
  errors: string;
}

export interface DesignBrowserToolResult {
  text: string;
  image?: { mimeType: 'image/png'; bytes: Buffer; width: number; height: number };
}

export interface AgentBrowserRuntimeOptions {
  executablePath: string;
  browserExecutablePath: string;
  scratchRoot: string;
  socketRoot: string;
  requireCodeSignature?: boolean;
  execute?: typeof execFileOwnedPortable;
  attestResources?: () => Promise<void>;
}

export interface DesignBrowserOwner {
  attest(): Promise<void>;
  recover(): Promise<void>;
  openCandidate(input: {
    designId: string;
    runId: string;
    generationId: string;
    origin: string;
    lease: PreviewGatewayBrowserLease;
  }): Promise<DesignBrowserObservation>;
  inspect(
    runId: string,
    operation: Exclude<InspectDesignOperation, { operation: 'open_candidate' }>
  ): Promise<DesignBrowserToolResult>;
  abortRun(runId: string): void;
  closeRun(runId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export function parseInspectDesignOperation(value: unknown): InspectDesignOperation {
  if (!isRecord(value) || typeof value.operation !== 'string') {
    throw new Error('inspect_design requires one supported operation.');
  }
  switch (value.operation) {
    case 'open_candidate':
    case 'observe':
    case 'accessibility':
      assertOnlyKeys(value, ['operation']);
      return { operation: value.operation };
    case 'set_viewport':
      assertOnlyKeys(value, ['operation', 'width', 'height']);
      if (typeof value.width !== 'number' || typeof value.height !== 'number') {
        throw new Error('inspect_design viewport values must be numbers.');
      }
      return { operation: 'set_viewport', width: value.width, height: value.height };
    case 'set_media':
      assertOnlyKeys(value, ['operation', 'colorScheme', 'reducedMotion']);
      if (
        !['light', 'dark'].includes(String(value.colorScheme)) ||
        typeof value.reducedMotion !== 'boolean'
      ) {
        throw new Error('inspect_design media values are invalid.');
      }
      return {
        operation: 'set_media',
        colorScheme: value.colorScheme as 'light' | 'dark',
        reducedMotion: value.reducedMotion
      };
    case 'screenshot':
      assertOnlyKeys(value, ['operation', 'ref', 'fullPage']);
      if (
        (value.ref !== undefined && typeof value.ref !== 'string') ||
        (value.fullPage !== undefined && typeof value.fullPage !== 'boolean')
      ) {
        throw new Error('inspect_design screenshot values are invalid.');
      }
      return {
        operation: 'screenshot',
        ...(value.ref === undefined ? {} : { ref: value.ref }),
        ...(value.fullPage === undefined ? {} : { fullPage: value.fullPage })
      };
    case 'act':
      return parseActionOperation(value);
    default:
      throw new Error('inspect_design operation is not supported.');
  }
}

interface BrowserMarker {
  schemaVersion: typeof MARKER_VERSION;
  designId: string;
  runId: string;
  session: string;
}

interface BrowserSession {
  designId: string;
  runId: string;
  generationId: string;
  origin: string;
  session: string;
  root: string;
  socketRoot: string;
  environment: NodeJS.ProcessEnv;
  lease: PreviewGatewayBrowserLease;
  refs: Set<string>;
  controller: AbortController;
}

/**
 * Owns the narrow Task Monki bridge to the pinned agent-browser CLI.
 * Preview owns page processes. The CLI owns browser automation.
 */
export class AgentBrowserRuntime implements DesignBrowserOwner {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly imageUsage = new Map<string, { bytes: number; count: number }>();
  private accepting = true;
  private attested = false;
  private readonly execute: typeof execFileOwnedPortable;

  constructor(private readonly options: AgentBrowserRuntimeOptions) {
    this.execute = options.execute ?? execFileOwnedPortable;
  }

  async attest(): Promise<void> {
    await Promise.all([
      assertExecutable(this.options.executablePath),
      assertExecutable(this.options.browserExecutablePath),
      ensurePrivateDirectory(this.options.scratchRoot),
      ensurePrivateDirectory(this.options.socketRoot)
    ]);
    await (this.options.attestResources?.() ?? this.attestPackagedResources());
    const { stdout } = await this.execute(
      this.options.executablePath,
      ['--version'],
      {
        timeout: 5_000,
        maxBuffer: 8 * 1024,
        env: runtimeProbeEnvironment()
      }
    );
    if (stdout.trim() !== `agent-browser ${AGENT_BROWSER_VERSION}`) {
      throw new Error('The packaged Design browser runtime has an unexpected version.');
    }
    this.attested = true;
  }

  private async attestPackagedResources(): Promise<void> {
    const root = path.dirname(this.options.executablePath);
    const expectedBrowserExecutable = path.join(
      root,
      'chrome',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    );
    if (path.resolve(this.options.browserExecutablePath) !== path.resolve(expectedBrowserExecutable)) {
      throw new Error('The packaged Design browser path is invalid.');
    }
    const manifestPath = path.join(root, 'runtime-manifest.json');
    const manifestStat = await fs.lstat(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > 8_192) {
      throw new Error('The packaged Design browser manifest is invalid.');
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      schemaVersion?: unknown;
      architecture?: unknown;
      agentBrowser?: { version?: unknown; commit?: unknown; binarySha256?: unknown };
      chrome?: { version?: unknown };
    };
    const expectedSha = AGENT_BROWSER_SHA256[process.arch];
    if (
      !expectedSha ||
      manifest.schemaVersion !== 1 ||
      manifest.architecture !== process.arch ||
      manifest.agentBrowser?.version !== AGENT_BROWSER_VERSION ||
      manifest.agentBrowser.commit !== AGENT_BROWSER_COMMIT ||
      manifest.agentBrowser.binarySha256 !== expectedSha ||
      manifest.chrome?.version !== CHROME_VERSION
    ) {
      throw new Error('The packaged Design browser runtime does not match its pin.');
    }
    await Promise.all([
      assertRegularNonEmpty(path.join(root, 'AGENT_BROWSER_LICENSE')),
      assertRegularNonEmpty(path.join(root, 'CHROME_FOR_TESTING_NOTICES'))
    ]);
    const chromeApp = path.resolve(
      path.dirname(this.options.browserExecutablePath),
      '..',
      '..'
    );
    const infoPlist = path.join(chromeApp, 'Contents', 'Info.plist');
    const [{ stdout: chromeVersion }, { stdout: agentArch }, { stdout: chromeArch }] =
      await Promise.all([
        this.execute(
          '/usr/bin/plutil',
          ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist],
          { timeout: 5_000, maxBuffer: 8 * 1024 }
        ),
        this.execute('/usr/bin/lipo', ['-archs', this.options.executablePath], {
          timeout: 5_000,
          maxBuffer: 8 * 1024
        }),
        this.execute('/usr/bin/lipo', ['-archs', this.options.browserExecutablePath], {
          timeout: 5_000,
          maxBuffer: 8 * 1024
        })
      ]);
    if (
      chromeVersion.trim() !== CHROME_VERSION ||
      !agentArch.trim().split(/\s+/u).includes(process.arch) ||
      !chromeArch.trim().split(/\s+/u).includes(process.arch)
    ) {
      throw new Error('The packaged Design browser architecture or version is invalid.');
    }
    if (this.options.requireCodeSignature !== false) {
      await Promise.all([
        this.execute(
          '/usr/bin/codesign',
          ['--verify', '--strict', this.options.executablePath],
          { timeout: 10_000, maxBuffer: 16 * 1024 }
        ),
        this.execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', chromeApp], {
          timeout: 30_000,
          maxBuffer: 64 * 1024
        })
      ]);
    }
  }

  async recover(): Promise<void> {
    await Promise.all([
      ensurePrivateDirectory(this.options.scratchRoot),
      ensurePrivateDirectory(this.options.socketRoot)
    ]);
    const entries = await fs.readdir(this.options.scratchRoot, { withFileTypes: true });
    const failures: Error[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const root = path.join(this.options.scratchRoot, entry.name);
      const marker = await readMarker(root).catch(() => undefined);
      if (!marker || runDirectoryName(marker.runId) !== entry.name) continue;
      const socketRoot = this.runSocketRoot(marker.runId);
      const environment = this.sessionEnvironment(marker, root, socketRoot);
      try {
        await this.runCli(environment, ['close'], undefined, 10_000);
        await removeOwnedScratch(root, marker);
        await removeOwnedSocketRoot(socketRoot, marker.runId);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Design browser startup cleanup is incomplete.'
      );
    }
  }

  async openCandidate(input: {
    designId: string;
    runId: string;
    generationId: string;
    origin: string;
    lease: PreviewGatewayBrowserLease;
  }): Promise<DesignBrowserObservation> {
    this.assertAvailable();
    return this.withRunOperation(input.runId, async () => {
      await this.closeRunUnlocked(input.runId);
      const root = this.runRoot(input.runId);
      const socketRoot = this.runSocketRoot(input.runId);
      await Promise.all([
        ensurePrivateDirectory(root),
        ensurePrivateDirectory(socketRoot)
      ]);
      const marker: BrowserMarker = {
        schemaVersion: MARKER_VERSION,
        designId: input.designId,
        runId: input.runId,
        session: sessionName(input.runId)
      };
      await writePrivateJson(path.join(root, MARKER_FILE), marker);
      await writePrivateJson(path.join(root, 'action-policy.json'), actionPolicy());
      const environment = this.sessionEnvironment(marker, root, socketRoot, {
        origin: input.origin,
        proxyUrl: input.lease.proxyUrl
      });
      const session: BrowserSession = {
        ...input,
        session: marker.session,
        root,
        socketRoot,
        environment,
        lease: input.lease,
        refs: new Set(),
        controller: new AbortController()
      };
      this.sessions.set(input.runId, session);
      try {
        await this.runCli(
          environment,
          ['open', input.origin],
          session.controller.signal,
          OPEN_TIMEOUT_MS
        );
        return await this.observeUnlocked(session);
      } catch (error) {
        await this.closeRunUnlocked(input.runId).catch(() => undefined);
        throw error;
      }
    });
  }

  inspect(
    runId: string,
    operation: Exclude<InspectDesignOperation, { operation: 'open_candidate' }>
  ): Promise<DesignBrowserToolResult> {
    this.assertAvailable();
    return this.withRunOperation(runId, async () => {
      const session = this.requireSession(runId);
      switch (operation.operation) {
        case 'observe':
          return { text: formatObservation(await this.observeUnlocked(session)) };
        case 'act': {
          await this.runCli(
            session.environment,
            actionArguments(operation, session.refs),
            session.controller.signal
          );
          return { text: formatObservation(await this.observeUnlocked(session)) };
        }
        case 'set_viewport': {
          if (
            !Number.isInteger(operation.width) ||
            !Number.isInteger(operation.height) ||
            operation.width < 320 ||
            operation.width > 2_560 ||
            operation.height < 320 ||
            operation.height > 2_000
          ) {
            throw new Error('Design viewport must be between 320x320 and 2560x2000.');
          }
          await this.runCli(
            session.environment,
            ['set', 'viewport', String(operation.width), String(operation.height)],
            session.controller.signal
          );
          return { text: formatObservation(await this.observeUnlocked(session)) };
        }
        case 'set_media': {
          const args = ['set', 'media', operation.colorScheme];
          if (operation.reducedMotion) args.push('reduced-motion');
          await this.runCli(session.environment, args, session.controller.signal);
          return { text: formatObservation(await this.observeUnlocked(session)) };
        }
        case 'screenshot':
          return this.screenshotUnlocked(session, operation);
        case 'accessibility': {
          const result = await this.runCli(
            session.environment,
            ['a11y'],
            session.controller.signal
          );
          return { text: boundedText(result) };
        }
      }
    });
  }

  abortRun(runId: string): void {
    this.sessions.get(runId)?.controller.abort(
      new Error('Design browser verification was canceled.')
    );
  }

  closeRun(runId: string): Promise<void> {
    this.abortRun(runId);
    return this.withRunOperation(runId, () => this.closeRunUnlocked(runId)).finally(
      () => this.imageUsage.delete(runId)
    );
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const session of this.sessions.values()) session.controller.abort();
    const closeResults = await Promise.allSettled(
      [...this.sessions.keys()].map((runId) =>
        this.withRunOperation(runId, () => this.closeRunUnlocked(runId))
      )
    );
    await Promise.allSettled(this.operations.values());
    this.imageUsage.clear();
    const failures = closeResults.flatMap((result) =>
      result.status === 'rejected'
        ? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
        : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Design browser shutdown cleanup is incomplete.');
    }
  }

  private async observeUnlocked(session: BrowserSession): Promise<DesignBrowserObservation> {
    const [snapshot, consoleOutput, errors] = await Promise.all([
      this.runCli(session.environment, ['snapshot', '-i', '-c'], session.controller.signal),
      this.runCli(session.environment, ['console'], session.controller.signal),
      this.runCli(session.environment, ['errors'], session.controller.signal)
    ]);
    session.refs = snapshotRefs(snapshot);
    return {
      snapshot: boundedText(snapshot),
      console: boundedText(consoleOutput),
      errors: boundedText(errors)
    };
  }

  private async screenshotUnlocked(
    session: BrowserSession,
    operation: Extract<InspectDesignOperation, { operation: 'screenshot' }>
  ): Promise<DesignBrowserToolResult> {
    if (operation.ref) requireCurrentRef(operation.ref, session.refs);
    const screenshotPath = path.join(session.root, `screenshot-${randomUUID()}.png`);
    const args = operation.ref
      ? ['screenshot', operation.ref, screenshotPath]
      : ['screenshot', screenshotPath];
    if (operation.fullPage) args.push('--full');
    try {
      await this.runCli(session.environment, args, session.controller.signal);
      const bytes = await fs.readFile(screenshotPath);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error('Design screenshot exceeds the allowed size.');
      }
      const usage = this.imageUsage.get(session.runId) ?? { bytes: 0, count: 0 };
      if (
        usage.count >= MAX_RUN_SCREENSHOTS ||
        usage.bytes + bytes.byteLength > MAX_RUN_IMAGE_BYTES
      ) {
        throw new Error('This Design Run reached its temporary screenshot limit.');
      }
      const { width, height } = pngDimensions(bytes);
      this.imageUsage.set(session.runId, {
        count: usage.count + 1,
        bytes: usage.bytes + bytes.byteLength
      });
      return {
        text: `Screenshot captured at ${width} by ${height} pixels.`,
        image: { mimeType: 'image/png', bytes, width, height }
      };
    } finally {
      await fs.unlink(screenshotPath).catch(() => undefined);
    }
  }

  private async closeRunUnlocked(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) return;
    session.controller.abort();
    const closeController = new AbortController();
    let browserClosed = false;
    try {
      await this.runCli(session.environment, ['close'], closeController.signal, 10_000);
      browserClosed = true;
    } finally {
      await session.lease.close().catch(() => undefined);
      if (browserClosed) {
        const marker = await readMarker(session.root);
        await removeOwnedScratch(session.root, marker);
        await removeOwnedSocketRoot(session.socketRoot, runId);
        this.sessions.delete(runId);
      }
    }
  }

  private runCli(
    environment: NodeJS.ProcessEnv,
    argv: string[],
    signal?: AbortSignal,
    timeout = COMMAND_TIMEOUT_MS
  ): Promise<string> {
    return this.execute(
      this.options.executablePath,
      ['--json', ...argv],
      {
        cwd: this.options.scratchRoot,
        env: environment,
        timeout,
        maxBuffer: MAX_TEXT_BYTES * 2,
        signal
      }
    ).then(({ stdout }) => boundedText(normalizeCliOutput(stdout)));
  }

  private sessionEnvironment(
    marker: BrowserMarker,
    root: string,
    socketRoot: string,
    network?: { origin: string; proxyUrl: string }
  ): NodeJS.ProcessEnv {
    const hostname = network ? new URL(network.origin).hostname : undefined;
    return {
      PATH: '/usr/bin:/bin',
      TMPDIR: root,
      AGENT_BROWSER_SESSION: marker.session,
      AGENT_BROWSER_NAMESPACE: marker.session,
      AGENT_BROWSER_SOCKET_DIR: socketRoot,
      AGENT_BROWSER_EXECUTABLE_PATH: this.options.browserExecutablePath,
      AGENT_BROWSER_ACTION_POLICY: path.join(root, 'action-policy.json'),
      AGENT_BROWSER_CONTENT_BOUNDARIES: '1',
      AGENT_BROWSER_MAX_OUTPUT: String(MAX_TEXT_BYTES),
      AGENT_BROWSER_IDLE_TIMEOUT_MS: '60000',
      AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: '0',
      AGENT_BROWSER_SCREENSHOT_DIR: root,
      AGENT_BROWSER_SCREENSHOT_FORMAT: 'png',
      AGENT_BROWSER_PLUGINS: '[]',
      ...(network
        ? {
            AGENT_BROWSER_ALLOWED_DOMAINS: hostname,
            AGENT_BROWSER_PROXY: network.proxyUrl,
            AGENT_BROWSER_PROXY_BYPASS: '<-loopback>'
          }
        : {})
    };
  }

  private requireSession(runId: string): BrowserSession {
    const session = this.sessions.get(runId);
    if (!session) throw new Error('This Design Run has no open browser candidate.');
    return session;
  }

  private runRoot(runId: string): string {
    if (!UUID.test(runId)) throw new Error('Design browser Run identity is invalid.');
    return path.join(this.options.scratchRoot, runDirectoryName(runId));
  }

  private runSocketRoot(runId: string): string {
    if (!UUID.test(runId)) throw new Error('Design browser Run identity is invalid.');
    return path.join(
      this.options.socketRoot,
      `r-${createHash('sha256').update(runId).digest('hex').slice(0, 8)}`
    );
  }

  private withRunOperation<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(runId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(action);
    this.operations.set(runId, operation);
    return operation.finally(() => {
      if (this.operations.get(runId) === operation) this.operations.delete(runId);
    });
  }

  private assertAvailable(): void {
    if (!this.accepting || !this.attested) {
      throw new Error('The packaged Design browser runtime is unavailable.');
    }
  }
}

function actionArguments(
  operation: Extract<InspectDesignOperation, { operation: 'act' }>,
  refs: ReadonlySet<string>
): string[] {
  const ref = operation.ref;
  const value = boundedValue(operation.value);
  switch (operation.action) {
    case 'click':
      return ['click', requireCurrentRef(ref, refs)];
    case 'double_click':
      return ['dblclick', requireCurrentRef(ref, refs)];
    case 'hover':
      return ['hover', requireCurrentRef(ref, refs)];
    case 'focus':
      return ['focus', requireCurrentRef(ref, refs)];
    case 'fill':
      return ['fill', requireCurrentRef(ref, refs), requireValue(value)];
    case 'type':
      return ['type', requireCurrentRef(ref, refs), requireValue(value)];
    case 'key':
      return ['press', requireKey(value)];
    case 'select': {
      const values = operation.values?.map(boundedValue).filter((item): item is string => item !== undefined) ?? [];
      if (values.length === 0 || values.length > 20) {
        throw new Error('Design select requires between 1 and 20 bounded values.');
      }
      return ['select', requireCurrentRef(ref, refs), ...values];
    }
    case 'check':
      return ['check', requireCurrentRef(ref, refs)];
    case 'uncheck':
      return ['uncheck', requireCurrentRef(ref, refs)];
    case 'scroll': {
      const amount = operation.amount ?? 300;
      if (!Number.isInteger(amount) || amount < 1 || amount > 2_000) {
        throw new Error('Design scroll distance must be between 1 and 2000 pixels.');
      }
      const direction = operation.direction ?? 'down';
      return ref
        ? ['scroll', direction, String(amount), '--selector', requireCurrentRef(ref, refs)]
        : ['scroll', direction, String(amount)];
    }
    case 'scroll_into_view':
      return ['scrollintoview', requireCurrentRef(ref, refs)];
    case 'drag':
      return [
        'drag',
        requireCurrentRef(ref, refs),
        requireCurrentRef(operation.targetRef, refs)
      ];
    case 'wait': {
      const milliseconds = operation.milliseconds ?? 250;
      if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 2_000) {
        throw new Error('Design browser waits must be between 0 and 2000 milliseconds.');
      }
      return ['wait', String(milliseconds)];
    }
  }
}

function snapshotRefs(snapshot: string): Set<string> {
  return new Set(
    [...snapshot.matchAll(/\bref=@?(e[1-9][0-9]{0,4})\b/gu)].map(
      (match) => `@${match[1]}`
    )
  );
}

function actionPolicy(): Record<string, unknown> {
  return {
    default: 'deny',
    allow: [
      'launch',
      'navigate',
      'snapshot',
      'console',
      'errors',
      'click',
      'dblclick',
      'hover',
      'focus',
      'fill',
      'type',
      'press',
      'select',
      'check',
      'uncheck',
      'scroll',
      'scrollintoview',
      'drag',
      'wait',
      'viewport',
      'emulatemedia',
      'screenshot',
      'a11y',
      'close'
    ]
  };
}

function formatObservation(observation: DesignBrowserObservation): string {
  return boundedText(
    `Snapshot:\n${observation.snapshot}\n\nConsole:\n${observation.console}\n\nRuntime errors:\n${observation.errors}`
  );
}

function normalizeCliOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '(no output)';
  try {
    const parsed = JSON.parse(trimmed) as { success?: unknown; error?: unknown; data?: unknown };
    if (parsed.success === false) {
      throw new Error(
        typeof parsed.error === 'string' ? parsed.error : 'agent-browser command failed.'
      );
    }
    return typeof parsed.data === 'string'
      ? parsed.data
      : JSON.stringify(parsed.data ?? parsed);
  } catch (error) {
    if (error instanceof SyntaxError) return trimmed;
    throw error;
  }
}

function boundedText(value: string): string {
  const normalized = value.replaceAll('\0', '').trim();
  if (Buffer.byteLength(normalized, 'utf8') <= MAX_TEXT_BYTES) return normalized;
  return `${Buffer.from(normalized, 'utf8').subarray(0, MAX_TEXT_BYTES).toString('utf8')}\n[truncated]`;
}

function boundedValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw new Error('Design browser action value is too large.');
  }
  return value;
}

function requireValue(value: string | undefined): string {
  if (value === undefined) throw new Error('This Design browser action requires a value.');
  return value;
}

function requireKey(value: string | undefined): string {
  const key = requireValue(value);
  if (!/^[A-Za-z0-9+_-]{1,64}$/u.test(key)) {
    throw new Error('Design browser key input is invalid.');
  }
  return key;
}

function requireCurrentRef(value: string | undefined, refs: ReadonlySet<string>): string {
  if (!value || !REF.test(value) || !refs.has(value)) {
    throw new Error('Design browser action requires a current element reference.');
  }
  return value;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.byteLength < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error('Design browser returned an invalid PNG screenshot.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 5_120 || height > 20_000) {
    throw new Error('Design screenshot dimensions are outside the allowed bounds.');
  }
  return { width, height };
}

function sessionName(runId: string): string {
  return `t${createHash('sha256').update(runId).digest('hex').slice(0, 8)}`;
}

function runDirectoryName(runId: string): string {
  return `run-${createHash('sha256').update(runId).digest('hex').slice(0, 32)}`;
}

function runtimeProbeEnvironment(): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin' };
}

function parseActionOperation(
  value: Record<string, unknown>
): Extract<InspectDesignOperation, { operation: 'act' }> {
  assertOnlyKeys(value, [
    'operation',
    'action',
    'ref',
    'targetRef',
    'value',
    'values',
    'direction',
    'amount',
    'milliseconds'
  ]);
  const allowedActions = [
    'click',
    'double_click',
    'hover',
    'focus',
    'fill',
    'type',
    'key',
    'select',
    'check',
    'uncheck',
    'scroll',
    'scroll_into_view',
    'drag',
    'wait'
  ] as const;
  if (!allowedActions.includes(value.action as (typeof allowedActions)[number])) {
    throw new Error('inspect_design action is not supported.');
  }
  if (
    (value.ref !== undefined && typeof value.ref !== 'string') ||
    (value.targetRef !== undefined && typeof value.targetRef !== 'string') ||
    (value.value !== undefined && typeof value.value !== 'string') ||
    (value.values !== undefined &&
      (!Array.isArray(value.values) ||
        value.values.some((entry) => typeof entry !== 'string'))) ||
    (value.direction !== undefined &&
      !['up', 'down', 'left', 'right'].includes(String(value.direction))) ||
    (value.amount !== undefined && typeof value.amount !== 'number') ||
    (value.milliseconds !== undefined && typeof value.milliseconds !== 'number')
  ) {
    throw new Error('inspect_design action values are invalid.');
  }
  return {
    operation: 'act',
    action: value.action as (typeof allowedActions)[number],
    ...(value.ref === undefined ? {} : { ref: value.ref }),
    ...(value.targetRef === undefined ? {} : { targetRef: value.targetRef }),
    ...(value.value === undefined ? {} : { value: value.value }),
    ...(value.values === undefined ? {} : { values: value.values as string[] }),
    ...(value.direction === undefined
      ? {}
      : { direction: value.direction as 'up' | 'down' | 'left' | 'right' }),
    ...(value.amount === undefined ? {} : { amount: value.amount }),
    ...(value.milliseconds === undefined
      ? {}
      : { milliseconds: value.milliseconds })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error('inspect_design received an unsupported argument.');
  }
}

async function assertExecutable(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (process.platform !== 'win32' && (stat.mode & 0o111) === 0)
  ) {
    throw new Error(`Design browser executable is invalid: ${filePath}`);
  }
}

async function assertRegularNonEmpty(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
    throw new Error('A packaged Design browser legal resource is invalid.');
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Design browser scratch root is invalid.');
  }
  await fs.chmod(directory, 0o700);
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  });
}

async function readMarker(root: string): Promise<BrowserMarker> {
  const markerPath = path.join(root, MARKER_FILE);
  const stat = await fs.lstat(markerPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024) {
    throw new Error('Design browser ownership marker is invalid.');
  }
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as BrowserMarker;
  if (
    marker.schemaVersion !== MARKER_VERSION ||
    !UUID.test(marker.designId) ||
    !UUID.test(marker.runId) ||
    marker.session !== sessionName(marker.runId)
  ) {
    throw new Error('Design browser ownership marker does not match its Run.');
  }
  return marker;
}

async function removeOwnedScratch(root: string, marker: BrowserMarker): Promise<void> {
  const expected = path.join(path.dirname(root), runDirectoryName(marker.runId));
  if (path.resolve(root) !== path.resolve(expected)) {
    throw new Error('Design browser scratch path does not match its ownership marker.');
  }
  await fs.rm(root, { recursive: true });
}

async function removeOwnedSocketRoot(root: string, runId: string): Promise<void> {
  const expected = path.join(
    path.dirname(root),
    `r-${createHash('sha256').update(runId).digest('hex').slice(0, 8)}`
  );
  if (path.resolve(root) !== path.resolve(expected)) {
    throw new Error('Design browser socket path does not match its Run.');
  }
  await fs.rm(root, { recursive: true });
}
