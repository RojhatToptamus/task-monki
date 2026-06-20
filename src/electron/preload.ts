import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppUpdateEvent,
  CancelRunRequest,
  CreateTaskRequest,
  ReadArtifactRequest,
  StartRunRequest,
  TaskManagerApi
} from '../shared/contracts';

const api: TaskManagerApi = {
  getDefaultRepositoryPath: () => ipcRenderer.invoke('repository:defaultPath'),
  validateRepository: (path) => ipcRenderer.invoke('repository:validate', path),
  listTasks: () => ipcRenderer.invoke('task:list'),
  createTask: (input: CreateTaskRequest) => ipcRenderer.invoke('task:create', input),
  startRun: (input: StartRunRequest) => ipcRenderer.invoke('codex:startRun', input),
  cancelRun: (input: CancelRunRequest) => ipcRenderer.invoke('codex:cancelRun', input),
  readArtifact: (input: ReadArtifactRequest) => ipcRenderer.invoke('artifact:read', input),
  onUpdate: (listener: (event: AppUpdateEvent) => void) => {
    const wrapped = (_: Electron.IpcRendererEvent, event: AppUpdateEvent) => listener(event);
    ipcRenderer.on('app:update', wrapped);
    return () => ipcRenderer.off('app:update', wrapped);
  }
};

contextBridge.exposeInMainWorld('taskManager', api);
