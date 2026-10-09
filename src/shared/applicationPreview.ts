import type {
  ConfigurationBindingChange,
  ConfigurationBindingsInspection,
  LogOptions,
  LogResult,
  PreviewDescription,
  PreviewRuntime,
  PreviewStatus,
  SecretRequirement,
  StopOptions
} from 'previewhost';

export interface PreviewConfigurationFile {
  name: 'preview.yaml' | 'preview.yml';
  text: string;
}
export interface PreviewSourceRequirement {
  service: string;
  declaration: string;
  directory: string;
  connected: boolean;
  missing?: boolean;
}
export type PreviewSecretAvailability = SecretRequirement & {
  availability: 'available' | 'missing' | 'locked' | 'new' | 'unavailable';
};
export interface PreviewFolderImpact {
  job: string;
  directory: string;
  previews: string[];
}
export interface PreviewRequirements {
  storage?: { services: string[]; state: 'new' | 'locked' | 'unlocked' };
  description?: PreviewDescription;
  secrets: PreviewSecretAvailability[];
  connections: string[];
  sources: PreviewSourceRequirement[];
}
export interface PreviewDiagnosis {
  attemptId: string;
  service?: string;
  title: string;
  summary: string;
  action:
    | 'agent'
    | 'task-agent'
    | 'install'
    | 'command'
    | 'readiness'
    | 'secrets'
    | 'source'
    | 'docker'
    | 'cleanup'
    | 'image'
    | 'logs';
  actionLabel: string;
  observed: string;
  unknown: string;
  guarantee: string;
  excerpt?: string;
  command?: string;
}

export interface ApplicationPreviewSnapshot {
  name: string;
  /** Canonical worktree root, matching runtime-resolved source paths in review. */
  projectDirectory?: string;
  hasConfigurationFile: boolean;
  configurationChanged?: boolean;
  /** Exact-source attempts belong to Design publication and cannot be edited in place. */
  designAttempts?: string[];
  status?: PreviewStatus;
  approval?: {
    attemptId: string;
    description: PreviewDescription;
    secrets: PreviewSecretAvailability[];
    affected?: PreviewFolderImpact[];
  };
  restartReview?: {
    id: string;
    description: PreviewDescription;
    affected: PreviewFolderImpact[];
  };
  requirements?: PreviewRequirements;
  fileSources?: PreviewSourceRequirement[];
  diagnosis?: PreviewDiagnosis;
  canRestore?: boolean;
  restoredRun?: boolean;
  configurationError?: string;
}
export interface ApplicationPreviewInstance {
  taskId: string;
  worktreeId: string;
  isCurrentWorktree: boolean;
  title: string;
  kind: 'task' | 'design';
  repositoryName: string;
  branch: string;
  projectDirectory: string;
  status: PreviewStatus;
  approvalPending: boolean;
}
export interface ApplicationPreviewRequest {
  taskId: string;
}
export interface ApplicationPreviewAttemptRequest
  extends ApplicationPreviewRequest {
  attemptId: string;
}
export interface ApplicationPreviewConfigurationRequest
  extends ApplicationPreviewAttemptRequest {
  changes: ConfigurationBindingChange[];
}
export interface ApplicationPreviewRecommendation {
  type: 'static';
  directory: string;
  explanation: string;
}
/** One thing the project files say about running it; `source` is the file it came from. */
export interface PreviewProjectFact {
  label: 'Application' | 'Dependencies' | 'Environment' | 'Services';
  detail: string;
  source: string;
}
export interface ApplicationPreviewApi {
  readApplicationPreviewFile(
    input: ApplicationPreviewRequest & { draftId?: string }
  ): Promise<{
    original?: PreviewConfigurationFile;
    file?: PreviewConfigurationFile;
    files?: PreviewConfigurationFile[];
    previous?: PreviewConfigurationFile;
    reconciliation?: {
      text: string;
      changes: string[];
      concealedKeys: string[];
    };
  }>;
  saveApplicationPreviewFile(
    input: ApplicationPreviewRequest & {
      original?: PreviewConfigurationFile;
      text: string;
    }
  ): Promise<ApplicationPreviewSnapshot>;
  chooseApplicationPreviewFile(
    input: ApplicationPreviewRequest & {
      keep: PreviewConfigurationFile['name'];
      files: PreviewConfigurationFile[];
    }
  ): Promise<ApplicationPreviewSnapshot>;
  inspectApplicationPreviewSetup(input: ApplicationPreviewRequest): Promise<{
    projectDirectory: string;
    recommendations: ApplicationPreviewRecommendation[];
    facts: PreviewProjectFact[];
  }>;

  listApplicationPreviews(): Promise<ApplicationPreviewInstance[]>;

  connectApplicationPreviewSource(
    input: ApplicationPreviewRequest & {
      attemptId?: string;
      service?: string;
      directory: string;
      expected: NonNullable<StopOptions['expected']>;
    }
  ): Promise<ApplicationPreviewSnapshot>;
  getApplicationPreview(
    input: ApplicationPreviewRequest
  ): Promise<ApplicationPreviewSnapshot>;
  startApplicationPreview(
    input: ApplicationPreviewRequest
  ): Promise<ApplicationPreviewSnapshot>;
  startRetainedApplicationPreview(
    input: ApplicationPreviewRequest
  ): Promise<ApplicationPreviewSnapshot>;
  approveApplicationPreview(
    input: ApplicationPreviewAttemptRequest
  ): Promise<void>;
  stopApplicationPreview(
    input: ApplicationPreviewRequest & {
      expected: NonNullable<StopOptions['expected']>;
    }
  ): Promise<ApplicationPreviewSnapshot>;
  cancelApplicationPreview(
    input: ApplicationPreviewAttemptRequest
  ): Promise<ApplicationPreviewSnapshot>;
  openApplicationPreview(
    input: ApplicationPreviewAttemptRequest & {
      service?: string;
      worktreeId?: string;
    }
  ): Promise<{ url: string; opened: boolean }>;
  readApplicationPreviewLogs(
    input: ApplicationPreviewAttemptRequest & LogOptions
  ): Promise<LogResult>;
  inspectApplicationPreviewConfiguration(
    input: ApplicationPreviewConfigurationRequest
  ): Promise<ConfigurationBindingsInspection>;

  rerunApplicationPreviewJob(
    input: ApplicationPreviewAttemptRequest & { job: string }
  ): Promise<ApplicationPreviewSnapshot>;
  deleteApplicationPreviewData(
    input: ApplicationPreviewRequest & {
      expected: {
        attemptId: string | null;
        resources: NonNullable<PreviewStatus['data']>['resources'];
      };
    }
  ): Promise<ApplicationPreviewSnapshot>;
}

type Vault = PreviewRuntime['keystore'];
/** Trusted desktop input only. No value-read endpoint, namespace selector, or event publication. */
export interface PreviewSecretsApi {
  has(input: { id: string }): Promise<boolean>;
  status(): ReturnType<Vault['status']>;
  list(input?: { query?: string; after?: string }): Promise<{
    ids: string[];
    next?: string;
    usage: Record<string, string[]>;
  }>;
  unlock(input: Parameters<Vault['unlock']>[0]): ReturnType<Vault['unlock']>;
  lock(): Promise<void>;
  remember(): Promise<void>;
  forget(): Promise<void>;
  create(input: { id: string; value: string }): Promise<void>;
  update(input: { id: string; value: string }): Promise<boolean>;
  remove(input: { id: string }): Promise<void>;
}
