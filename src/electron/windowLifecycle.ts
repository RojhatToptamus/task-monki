export interface ActivateWindowState {
  ipcHandlersInstalled: boolean;
  openWindowCount: number;
}

export function shouldCreateWindowOnActivate(state: ActivateWindowState): boolean {
  return state.ipcHandlersInstalled && state.openWindowCount === 0;
}
