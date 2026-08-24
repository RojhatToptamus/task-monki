import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const LAB_LEDGER_SCHEMA_VERSION = 'task-monki/discourse-lab-ledger@v5' as const;

export interface LabComponentLock {
  corpusVersion: string;
  participantCorpusSha256: string;
  oracleCorpusSha256: string;
  /** Aggregate digest of the evaluation runtime sources, excluding tests. */
  labSourceSha256: string;
  preregistrationVersion: string;
  preregistrationSha256: string;
  promptVersion: string;
  outputSchemaVersion: string;
  scoringVersion: string;
  protocolVersion: string;
}

export interface LabRunBudgetManifest {
  maximumCalls: number;
  maximumRounds: number;
  /** Aggregate concise-output target. It is not a censoring threshold. */
  maximumOutputTokens: number;
  /** Aggregate emergency interruption ceiling across the authorized calls. */
  maximumOutputTokenSafetyCeiling: number;
  maximumObservedTotalTokens: number;
  maximumCallMs: number;
  maximumExperimentMs: number;
}

export interface LabRunManifest {
  schemaVersion: typeof LAB_LEDGER_SCHEMA_VERSION;
  runId: string;
  phase: 'HARNESS_VALIDATION' | 'DEVELOPMENT' | 'CONFIRMATION';
  status: 'PLANNED';
  createdAt: string;
  driver: {
    id: string;
    model: string;
    modelProvider?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    seed: number | null;
    seedControl: 'SUPPORTED' | 'UNSUPPORTED';
    hardOutputTokenLimit: boolean;
    hardCallTimeLimit: boolean;
    textOnlyAttestation: 'PROVIDER_ENFORCED' | 'HARNESS_DETECTED';
    boundaryClass: 'PROVIDER_ENFORCED_STRICT' | 'H1_DEVELOPMENT_HARNESS_VERIFIED';
    harnessVerifiedTextIsolation: boolean;
    streamingOutputTokenInterrupt: boolean;
    providerReportedTokenUsage: boolean;
  };
  locks: LabComponentLock;
  caseIds: string[];
  conditionIds: string[];
  budgets: LabRunBudgetManifest;
  /** Explicit authorization to consume provider usage; unrelated to confirmation partition state. */
  providerUsageExplicitlyAuthorized: boolean;
}

export interface LabSemanticRunContext {
  phase: Extract<LabRunManifest['phase'], 'DEVELOPMENT' | 'CONFIRMATION'>;
  locks: LabComponentLock;
  driver: LabRunManifest['driver'];
  caseIds: readonly string[];
  conditionIds: readonly string[];
  budgets: LabRunBudgetManifest;
}

export interface LabLedgerEvent {
  eventType: string;
  occurredAt: string;
  caseId?: string;
  conditionId?: string;
  callId?: string;
  artifactSha256?: string;
  detail?: Record<string, unknown>;
}

/**
 * Evaluation artifacts are intentionally separate from every Task Monki store.
 * Each record is write-once so a report can be regenerated without silently
 * rewriting the observed trajectory.
 */
export class LabArtifactLedger {
  private nextEvent = 1;
  private initializedManifest?: LabRunManifest;

  constructor(
    readonly rootDirectory: string,
    readonly runId: string
  ) {}

  get runDirectory(): string {
    return path.join(this.rootDirectory, 'runs', this.runId);
  }

  async initialize(manifest: LabRunManifest): Promise<void> {
    if (manifest.runId !== this.runId || manifest.schemaVersion !== LAB_LEDGER_SCHEMA_VERSION) {
      throw new Error('The Discourse Lab manifest does not match this run ledger.');
    }
    await privateDirectory(path.join(this.rootDirectory, 'runs'));
    await fs.mkdir(this.runDirectory, { mode: 0o700 });
    await ensurePrivateDirectory(this.runDirectory);
    await privateDirectory(path.join(this.runDirectory, 'events'));
    await privateDirectory(path.join(this.runDirectory, 'artifacts'));
    await privateDirectory(path.join(this.runDirectory, 'reports'));
    await writeExclusiveJson(path.join(this.runDirectory, 'manifest.json'), manifest);
    this.initializedManifest = structuredClone(manifest);
  }

  assertRunContext(
    phase: LabRunManifest['phase'],
    locks: LabComponentLock
  ): void {
    if (!this.initializedManifest) {
      throw new Error('The Discourse Lab ledger must be initialized before execution.');
    }
    if (this.initializedManifest.phase !== phase) {
      throw new Error(`The Discourse Lab ledger phase is not ${phase}.`);
    }
    if (stableJson(this.initializedManifest.locks) !== stableJson(locks)) {
      throw new Error('The Discourse Lab ledger locks do not match the active experiment plan.');
    }
  }

  assertSemanticRunContext(context: LabSemanticRunContext): void {
    this.assertRunContext(context.phase, context.locks);
    const manifest = this.initializedManifest!;
    const problems: string[] = [];
    if (!manifest.providerUsageExplicitlyAuthorized) {
      problems.push('providerUsageExplicitlyAuthorized');
    }
    if (stableJson(manifest.driver) !== stableJson(context.driver)) {
      problems.push('driver');
    }
    if (stableJson(canonicalSet(manifest.caseIds)) !== stableJson(canonicalSet(context.caseIds))) {
      problems.push('caseIds');
    }
    if (
      stableJson(canonicalSet(manifest.conditionIds)) !==
      stableJson(canonicalSet(context.conditionIds))
    ) {
      problems.push('conditionIds');
    }
    if (stableJson(manifest.budgets) !== stableJson(context.budgets)) {
      problems.push('budgets');
    }
    problems.push(...semanticBoundaryProblems(manifest));
    if (problems.length > 0) {
      throw new Error(
        `Semantic Discourse Lab run context failed: ${problems.join(', ')}.`
      );
    }
  }

  async append(event: LabLedgerEvent): Promise<void> {
    const sequence = this.nextEvent++;
    const name = `${String(sequence).padStart(6, '0')}-${safeSegment(event.eventType)}.json`;
    await writeExclusiveJson(path.join(this.runDirectory, 'events', name), {
      schemaVersion: LAB_LEDGER_SCHEMA_VERSION,
      sequence,
      ...event
    });
  }

  async putArtifact(value: unknown): Promise<{ sha256: string; path: string }> {
    const text = `${stableJson(value)}\n`;
    const sha256 = sha256Text(text);
    const artifactPath = path.join(this.runDirectory, 'artifacts', `${sha256}.json`);
    try {
      await writeExclusive(artifactPath, text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await fs.readFile(artifactPath, 'utf8')) !== text) {
        throw new Error(`Content-addressed artifact collision: ${sha256}`);
      }
    }
    return { sha256, path: artifactPath };
  }

  async writeReport(name: string, value: unknown): Promise<string> {
    const reportPath = path.join(this.runDirectory, 'reports', `${safeSegment(name)}.json`);
    await writeExclusiveJson(reportPath, value);
    return reportPath;
  }
}

function semanticBoundaryProblems(manifest: LabRunManifest): string[] {
  const problems: string[] = [];
  const { driver, budgets } = manifest;
  if (
    !Number.isFinite(budgets.maximumOutputTokenSafetyCeiling) ||
    budgets.maximumOutputTokenSafetyCeiling <= 0
  ) {
    problems.push('maximumOutputTokenSafetyCeiling');
  }
  if (budgets.maximumOutputTokenSafetyCeiling < budgets.maximumOutputTokens) {
    problems.push('outputTokenSafetyCeilingBelowTarget');
  }
  if (!driver.hardCallTimeLimit) problems.push('hardCallTimeLimit');
  if (!driver.providerReportedTokenUsage) problems.push('providerReportedTokenUsage');

  if (driver.boundaryClass === 'PROVIDER_ENFORCED_STRICT') {
    if (!driver.hardOutputTokenLimit) problems.push('hardOutputTokenLimit');
    if (driver.textOnlyAttestation !== 'PROVIDER_ENFORCED') {
      problems.push('providerEnforcedTextOnly');
    }
  } else {
    if (manifest.phase !== 'DEVELOPMENT') problems.push('developmentOnlyBoundary');
    if (driver.hardOutputTokenLimit) problems.push('fallbackHardOutputTokenClaim');
    if (driver.textOnlyAttestation !== 'HARNESS_DETECTED') {
      problems.push('harnessDetectedTextOnly');
    }
    if (!driver.harnessVerifiedTextIsolation) problems.push('harnessVerifiedTextIsolation');
    if (!driver.streamingOutputTokenInterrupt) problems.push('streamingOutputTokenInterrupt');
  }
  return problems;
}

export async function sha256File(filePath: string): Promise<string> {
  return sha256Text(await fs.readFile(filePath));
}

export function sha256Text(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)])
  );
}

function canonicalSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await ensurePrivateDirectory(directory);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Discourse Lab path is not a real directory: ${directory}`);
  }
  if (process.platform !== 'win32') {
    await fs.chmod(directory, 0o700);
    const secured = await fs.lstat(directory);
    if ((secured.mode & 0o077) !== 0) {
      throw new Error(`Discourse Lab directory is not private: ${directory}`);
    }
  }
}

async function writeExclusiveJson(filePath: string, value: unknown): Promise<void> {
  await writeExclusive(filePath, `${stableJson(value)}\n`);
}

async function writeExclusive(filePath: string, value: string): Promise<void> {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
}

function safeSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-|-$/gu, '');
  if (!normalized || normalized.length > 96) {
    throw new Error(`Unsafe Discourse Lab artifact name: ${value}`);
  }
  return normalized;
}
