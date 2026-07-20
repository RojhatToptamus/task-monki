import { describe, expect, it } from 'vitest';
import { resolveBoardNavigationTarget } from './boardKeyboardNavigation';

describe('board keyboard navigation', () => {
  const columns = [['a', 'b', 'c'], [], ['d', 'e'], ['f']];

  it('moves within a lane without leaving its bounds', () => {
    expect(resolveBoardNavigationTarget(columns, 0, 1, 'ArrowDown')).toEqual({
      columnIndex: 0,
      taskIndex: 2
    });
    expect(resolveBoardNavigationTarget(columns, 0, 0, 'ArrowUp')).toEqual({
      columnIndex: 0,
      taskIndex: 0
    });
    expect(resolveBoardNavigationTarget(columns, 0, 1, 'Home')).toEqual({
      columnIndex: 0,
      taskIndex: 0
    });
    expect(resolveBoardNavigationTarget(columns, 0, 1, 'End')).toEqual({
      columnIndex: 0,
      taskIndex: 2
    });
  });

  it('skips empty lanes and preserves the nearest available row', () => {
    expect(resolveBoardNavigationTarget(columns, 0, 2, 'ArrowRight')).toEqual({
      columnIndex: 2,
      taskIndex: 1
    });
    expect(resolveBoardNavigationTarget(columns, 2, 1, 'ArrowRight')).toEqual({
      columnIndex: 3,
      taskIndex: 0
    });
    expect(resolveBoardNavigationTarget(columns, 2, 0, 'ArrowLeft')).toEqual({
      columnIndex: 0,
      taskIndex: 0
    });
  });
});
