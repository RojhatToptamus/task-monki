import type {
  ConfigurationBindingChange,
  DependencyBinding,
  ConfigurationBindingsInspection,
  LogOptions,
  LogResult,
  PreviewDescription,
  PreviewRuntime,
  PreviewStatus,
  StopOptions
} from 'previewhost';

export interface ApplicationPreviewSnapshot {
  name: string;
  hasConfigurationFile: boolean;
  /** Exact-source attempts belong to Design publication and cannot be edited in place. */
  designAttempts?: string[];
  status?: PreviewStatus;
  approval?: { attemptId: string; description: PreviewDescription };
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
export interface ApplicationPreviewApi {
  listApplicationPreviews(): Promise<ApplicationPreviewInstance[]>;
  connectApplicationPreviewDependency(
    input: ApplicationPreviewAttemptRequest & {
      service: string;
      binding: DependencyBinding;
      expected: NonNullable<StopOptions['expected']>;
    }
  ): Promise<ApplicationPreviewSnapshot>;
  createApplicationPreviewConfiguration(
    input: ApplicationPreviewRequest & {
      type: 'command' | 'static';
      command?: string;
      directory: string;
    }
  ): Promise<ApplicationPreviewSnapshot>;
  connectApplicationPreviewSource(
    input: ApplicationPreviewAttemptRequest & {
      service?: string;
      directory: string;
      expected: NonNullable<StopOptions['expected']>;
    }
  ): Promise<ApplicationPreviewSnapshot>;
  getApplicationPreview(
    input: ApplicationPreviewRequest
  ): Promise<ApplicationPreviewSnapshot>;
  startApplicationPreview(
    input: ApplicationPreviewRequest & { source: 'file' | 'retained' }
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
    input: ApplicationPreviewAttemptRequest & { service?: string; worktreeId?: string }
  ): Promise<{ url: string; opened: boolean }>;
  readApplicationPreviewLogs(
    input: ApplicationPreviewAttemptRequest & LogOptions
  ): Promise<LogResult>;
  inspectApplicationPreviewConfiguration(
    input: ApplicationPreviewConfigurationRequest
  ): Promise<ConfigurationBindingsInspection>;
  applyApplicationPreviewConfiguration(
    input: ApplicationPreviewConfigurationRequest & {
      expected: NonNullable<StopOptions['expected']>;
    }
  ): Promise<ApplicationPreviewSnapshot>;
  saveApplicationPreviewConfiguration(
    input: ApplicationPreviewConfigurationRequest
  ): Promise<{ file: string; externalSources: string[] }>;
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
