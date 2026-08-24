export interface ActivateWindowState {
  ipcHandlersInstalled: boolean;
  openWindowCount: number;
  shuttingDown: boolean;
}

export function shouldCreateWindowOnActivate(state: ActivateWindowState): boolean {
  return !state.shuttingDown && state.ipcHandlersInstalled && state.openWindowCount === 0;
}
