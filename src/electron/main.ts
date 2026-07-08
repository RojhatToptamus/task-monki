import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import { TaskManagerService } from '../core/app/TaskManagerService';
import { AppSettingsStore } from '../core/settings/AppSettingsStore';
import type {
  AppUpdateEvent,
  ContinueRunRequest,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  GitHubPreflightRequest,
  InspectOpenTargetRequest,
  ExecuteOpenTargetActionRequest,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  RespondToInteractionRequest,
  RefinePromptRequest,
  StartRunRequest,
  StartReviewRequest,
  SteerRunRequest,
  RetryRunRequest,
  SyncAgentGoalRequest,
  ReadProtocolMessageRequest,
  TestExternalToolRequest,
  TransitionTaskRequest,
  UpdateAppSettingsRequest
} from '../shared/contracts';
import { createElectronOpenTargetHost } from './openTargetHost';
import { getMacDockIconPath } from './dockIcon';
import { getMainWindowChromeOptions } from './windowChrome';
import { shouldCreateWindowOnActivate } from './windowLifecycle';

let mainWindow: BrowserWindow | undefined;
let service: TaskManagerService;
let serviceCreated = false;
let ipcHandlersInstalled = false;
let quitAfterShutdown = false;
let shutdownPromise: Promise<void> | undefined;

const appId = 'dev.taskmonki.desktop';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'Task Monki',
    backgroundColor: '#101217',
    ...getMainWindowChromeOptions(process.platform),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'));
  }
}

function configureMacDockIcon(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  const iconPath = getMacDockIconPath({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  });
  if (fs.existsSync(iconPath)) {
    app.dock.setIcon(iconPath);
  }
}

function installIpcHandlers(): void {
  ipcMain.handle('repository:defaultPath', () => service.getDefaultRepositoryPath());
  ipcMain.handle('repository:chooseFolder', async () => {
    const options: OpenDialogOptions = {
      title: 'Add repository',
      properties: ['openDirectory']
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('agent:providerState', () => service.getAgentProviderState());
  ipcMain.handle('settings:get', () => service.getAppSettings());
  ipcMain.handle('settings:update', async (_, input: UpdateAppSettingsRequest) => {
    return service.updateAppSettings(input);
  });
  ipcMain.handle('settings:tools:status', () => service.getExternalToolStatus());
  ipcMain.handle('settings:tools:test', async (_, input: TestExternalToolRequest) => {
    return service.testExternalTool(input);
  });
  ipcMain.handle('openTarget:inspect', async (_, input: InspectOpenTargetRequest) => {
    return service.inspectOpenTarget(input);
  });
  ipcMain.handle('openTarget:execute', async (_, input: ExecuteOpenTargetActionRequest) => {
    return service.executeOpenTargetAction(input);
  });

  ipcMain.handle('repository:validate', async (_, repositoryPath: string) => {
    return service.validateRepository(repositoryPath);
  });

  ipcMain.handle('task:list', async () => {
    return service.listTasks();
  });

  ipcMain.handle('task:create', async (_, input: CreateTaskRequest) => {
    const task = await service.createTask(input);
    broadcast({
      type: 'task.updated',
      taskId: task.id,
      payload: task,
      at: new Date().toISOString()
    });
    return task;
  });

  ipcMain.handle('prompt:refine', async (_, input: RefinePromptRequest) => {
    return service.refinePrompt(input);
  });

  ipcMain.handle('worktree:prepare', async (_, input: PrepareWorktreeRequest) => {
    return service.prepareWorktree(input);
  });

  ipcMain.handle('codex:startRun', async (_, input: StartRunRequest) => {
    return service.startRun(input);
  });

  ipcMain.handle('codex:steerRun', async (_, input: SteerRunRequest) => {
    return service.steerRun(input);
  });

  ipcMain.handle('codex:continueRun', async (_, input: ContinueRunRequest) => {
    return service.continueRun(input);
  });

  ipcMain.handle('codex:retryRun', async (_, input: RetryRunRequest) => {
    return service.retryRun(input);
  });

  ipcMain.handle('codex:startReview', async (_, input: StartReviewRequest) => {
    return service.startReview(input);
  });

  ipcMain.handle('agent:syncGoal', async (_, input: SyncAgentGoalRequest) => {
    return service.syncAgentGoal(input);
  });

  ipcMain.handle('codex:cancelRun', async (_, { runId }: { runId: string }) => {
    await service.cancelRun({ runId });
  });

  ipcMain.handle(
    'agent:respondToInteraction',
    async (_, input: RespondToInteractionRequest) => {
      return service.respondToInteraction(input);
    }
  );

  ipcMain.handle('evidence:refresh', async (_, input: RefreshEvidenceRequest) => {
    return service.refreshEvidence(input);
  });

  ipcMain.handle('git:deliveryCommit', async (_, input: CreateDeliveryCommitRequest) => {
    return service.createDeliveryCommit(input);
  });

  ipcMain.handle('github:preflight', async (_, input: GitHubPreflightRequest) => {
    return service.preflightGitHub(input);
  });

  ipcMain.handle('github:publish', async (_, input: PublishBranchRequest) => {
    return service.publishBranch(input);
  });

  ipcMain.handle('github:createPullRequest', async (_, input: CreatePullRequestRequest) => {
    return service.createPullRequest(input);
  });

  ipcMain.handle('github:refresh', async (_, input: RefreshGitHubRequest) => {
    return service.refreshGitHub(input);
  });

  ipcMain.handle('task:transition', async (_, input: TransitionTaskRequest) => {
    return service.transitionTask(input);
  });

  ipcMain.handle('task:delete', async (_, input: DeleteTaskRequest) => {
    return service.deleteTask(input);
  });

  ipcMain.handle('artifact:read', async (_, { artifactId }: { artifactId: string }) => {
    return service.readArtifact({ artifactId });
  });

  ipcMain.handle(
    'agent:readProtocolMessage',
    async (_, input: ReadProtocolMessageRequest) => {
      return service.readProtocolMessage(input);
    }
  );
  ipcHandlersInstalled = true;
}

function broadcast(event: AppUpdateEvent): void {
  mainWindow?.webContents.send('app:update', event);
}

function configureDesktopCliPath(): void {
  const existingPath = process.env.PATH ?? '';
  const existingEntries = existingPath.split(path.delimiter).filter(Boolean);
  const windowsLocalGitPath = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd')
    : undefined;
  const commonEntries =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
      : process.platform === 'linux'
        ? ['/usr/local/bin', '/usr/bin', '/bin']
        : [
            'C:\\Program Files\\Git\\cmd',
            'C:\\Program Files\\GitHub CLI',
            windowsLocalGitPath
          ];

  const entries = [
    ...commonEntries.filter((entry): entry is string => Boolean(entry)),
    ...existingEntries
  ];
  process.env.PATH = [...new Set(entries)].join(path.delimiter);
}

function resolveDefaultRepositoryPath(): string {
  if (process.env.TASK_MANAGER_REPO_PATH !== undefined) {
    return process.env.TASK_MANAGER_REPO_PATH;
  }
  return app.isPackaged ? '' : process.cwd();
}

app.whenReady().then(async () => {
  app.setAppUserModelId(appId);
  configureDesktopCliPath();
  configureMacDockIcon();
  const defaultRepositoryPath = resolveDefaultRepositoryPath();
  service = new TaskManagerService(
    new FileTaskStore(path.join(app.getPath('userData'), 'task-store')),
    defaultRepositoryPath,
    undefined,
    {
      agentCwd: defaultRepositoryPath || app.getPath('home'),
      appSettingsStore: new AppSettingsStore(
        path.join(app.getPath('userData'), 'app-settings.json')
      ),
      openTargetHost: createElectronOpenTargetHost()
    }
  );
  serviceCreated = true;
  await service.init();
  service.events.on((event) => {
    broadcast(event);
  });
  installIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (quitAfterShutdown || !serviceCreated) {
    return;
  }
  event.preventDefault();
  shutdownPromise ??= service
    .shutdown()
    .catch((error: unknown) => {
      console.error('Failed to shut down the Codex App Server cleanly.', error);
    })
    .then(() => {
      quitAfterShutdown = true;
      app.quit();
    });
});

app.on('activate', () => {
  if (
    shouldCreateWindowOnActivate({
      ipcHandlersInstalled,
      openWindowCount: BrowserWindow.getAllWindows().length
    })
  ) {
    createWindow();
  }
});
