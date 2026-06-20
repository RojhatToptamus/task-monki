import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { FileTaskStore } from '../core/storage/FileTaskStore';
import { TaskManagerService } from '../core/app/TaskManagerService';
import type {
  AppUpdateEvent,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  GitHubPreflightRequest,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  RefinePromptRequest,
  RunTestsRequest,
  StartRunRequest,
  TransitionTaskRequest
} from '../shared/contracts';

let mainWindow: BrowserWindow | undefined;
let service: TaskManagerService;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'Task Manager',
    backgroundColor: '#101217',
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

function installIpcHandlers(): void {
  ipcMain.handle('repository:defaultPath', () => service.getDefaultRepositoryPath());

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

  ipcMain.handle('codex:cancelRun', async (_, { runId }: { runId: string }) => {
    await service.cancelRun({ runId });
  });

  ipcMain.handle('test:run', async (_, input: RunTestsRequest) => {
    return service.runTests(input);
  });

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

  ipcMain.handle('artifact:read', async (_, { artifactId }: { artifactId: string }) => {
    return service.readArtifact({ artifactId });
  });
}

function broadcast(event: AppUpdateEvent): void {
  mainWindow?.webContents.send('app:update', event);
}

app.whenReady().then(async () => {
  service = new TaskManagerService(
    new FileTaskStore(path.join(app.getPath('userData'), 'task-store')),
    process.cwd()
  );
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

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
