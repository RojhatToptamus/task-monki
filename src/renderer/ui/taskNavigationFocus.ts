export function taskNavigationReturnTarget(
  primaryTarget: HTMLElement | null | undefined,
  taskId: string | undefined,
  taskButtons: Iterable<HTMLElement>,
  fallbackTarget: HTMLElement | null | undefined
): HTMLElement | undefined {
  if (primaryTarget?.isConnected) {
    return primaryTarget;
  }
  if (taskId) {
    const matchingButton = Array.from(taskButtons).find(
      (button) => button.dataset.taskId === taskId && button.isConnected
    );
    if (matchingButton) {
      return matchingButton;
    }
  }
  return fallbackTarget?.isConnected ? fallbackTarget : undefined;
}
