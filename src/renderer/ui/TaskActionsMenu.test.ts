import { describe, expect, it } from 'vitest';
import { taskMenuGeometry } from './TaskActionsMenu';

describe('taskMenuGeometry', () => {
  it('places the menu in the available viewport space', () => {
    expect(taskMenuGeometry({ top: 180, bottom: 208 }, 720)).toEqual({
      placement: 'bottom',
      maxHeight: 420
    });
    expect(taskMenuGeometry({ top: 560, bottom: 588 }, 720)).toEqual({
      placement: 'top',
      maxHeight: 420
    });
  });
});
