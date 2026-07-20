export type BoardNavigationKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End';

export interface BoardNavigationTarget {
  columnIndex: number;
  taskIndex: number;
}

export function resolveBoardNavigationTarget(
  columns: readonly (readonly string[])[],
  columnIndex: number,
  taskIndex: number,
  key: string
): BoardNavigationTarget | undefined {
  const currentColumn = columns[columnIndex];
  if (!currentColumn?.length) {
    return undefined;
  }
  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End') {
    const nextTaskIndex =
      key === 'Home'
        ? 0
        : key === 'End'
          ? currentColumn.length - 1
          : Math.max(
              0,
              Math.min(
                currentColumn.length - 1,
                taskIndex + (key === 'ArrowUp' ? -1 : 1)
              )
            );
    return { columnIndex, taskIndex: nextTaskIndex };
  }
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') {
    return undefined;
  }
  const direction = key === 'ArrowLeft' ? -1 : 1;
  for (
    let nextColumnIndex = columnIndex + direction;
    nextColumnIndex >= 0 && nextColumnIndex < columns.length;
    nextColumnIndex += direction
  ) {
    const nextColumn = columns[nextColumnIndex];
    if (nextColumn?.length) {
      return {
        columnIndex: nextColumnIndex,
        taskIndex: Math.min(taskIndex, nextColumn.length - 1)
      };
    }
  }
  return { columnIndex, taskIndex };
}
