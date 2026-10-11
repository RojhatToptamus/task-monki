/**
 * Whether New task opens at its writing size. The size is the person's
 * arrangement, so it is kept in local storage and restored when the modal
 * opens again (DESIGN.md 11.2); losing it only opens the modal at its usual size.
 */
const EXPANDED_KEY = 'task-monki.new-task-expanded.v1';

export function readNewTaskExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeNewTaskExpanded(expanded: boolean): void {
  try {
    if (expanded) window.localStorage.setItem(EXPANDED_KEY, 'true');
    else window.localStorage.removeItem(EXPANDED_KEY);
  } catch {
    // Storage can be unavailable; the size is a convenience.
  }
}
