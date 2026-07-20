export const DEFAULT_NEW_TASK_PANEL_WIDTH = 520;
export const MIN_NEW_TASK_PANEL_WIDTH = 500;
export const MAX_NEW_TASK_PANEL_WIDTH = 760;
export const NEW_TASK_CANVAS_PAN_DURATION_MS = 360;

export function getNewTaskPanelWidthBounds(viewportWidth: number) {
  const max = Math.min(MAX_NEW_TASK_PANEL_WIDTH, Math.max(0, viewportWidth));
  return {
    min: Math.min(MIN_NEW_TASK_PANEL_WIDTH, max),
    max
  };
}

export function clampNewTaskPanelWidth(width: number, viewportWidth: number): number {
  const bounds = getNewTaskPanelWidthBounds(viewportWidth);
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

export function resizeNewTaskPanelFromPointer(
  startWidth: number,
  startX: number,
  currentX: number,
  viewportWidth: number
): number {
  return clampNewTaskPanelWidth(startWidth + startX - currentX, viewportWidth);
}

export function newTaskCanvasPanPosition(
  start: number,
  target: number,
  elapsedMs: number,
  durationMs = NEW_TASK_CANVAS_PAN_DURATION_MS
): number {
  if (durationMs <= 0) {
    return target;
  }
  const progress = Math.min(1, Math.max(0, elapsedMs / durationMs));
  const eased =
    progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
  return start + (target - start) * eased;
}

export function dragNewTaskCanvas(
  startScrollLeft: number,
  startX: number,
  currentX: number,
  maxScrollLeft: number
): number {
  return Math.min(
    Math.max(0, maxScrollLeft),
    Math.max(0, startScrollLeft + startX - currentX)
  );
}

export function shouldInterruptNewTaskCanvasPanForWheel(
  deltaX: number,
  deltaY: number,
  shiftKey: boolean
): boolean {
  const horizontalDelta = Math.abs(deltaX);
  const verticalDelta = Math.abs(deltaY);
  return (
    horizontalDelta > Math.max(0.5, verticalDelta) ||
    (shiftKey && verticalDelta > 0.5)
  );
}
