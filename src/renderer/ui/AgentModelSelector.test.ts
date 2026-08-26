import { describe, expect, it } from 'vitest';
import { agentModelMenuGeometry } from './AgentModelSelector';

describe('agentModelMenuGeometry', () => {
  it('places compact model menus inside their scroll boundary', () => {
    expect(agentModelMenuGeometry({
      trigger: { top: 540, right: 292, bottom: 568 },
      boundary: { top: 180, right: 312, bottom: 608, left: 68 },
      constrainWidth: true
    })).toEqual({ placement: 'top', maxHeight: 320, maxWidth: 220 });
    expect(agentModelMenuGeometry({
      trigger: { top: 210, right: 292, bottom: 238 },
      boundary: { top: 180, right: 312, bottom: 608, left: 68 },
      constrainWidth: true
    })).toEqual({ placement: 'bottom', maxHeight: 320, maxWidth: 220 });
  });
});
