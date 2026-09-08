import { describe, expect, it } from 'vitest';
import { agentModelMenuGeometry } from './AgentModelSelector';

describe('agentModelMenuGeometry', () => {
  it('prefers a usable menu below the trigger and otherwise uses the larger side', () => {
    expect(agentModelMenuGeometry({
      trigger: { top: 400, right: 120, bottom: 434, left: 20 },
      boundary: { top: 0, right: 300, bottom: 600, left: 0 }
    })).toEqual({ placement: 'bottom', maxHeight: 160, width: 260, alignRight: false });

    expect(agentModelMenuGeometry({
      trigger: { top: 120, right: 120, bottom: 150, left: 20 },
      boundary: { top: 0, right: 300, bottom: 250, left: 0 }
    })).toEqual({ placement: 'top', maxHeight: 152, width: 260, alignRight: false });
  });

  it('clamps width to the boundary and right-aligns near its edge', () => {
    expect(agentModelMenuGeometry({
      trigger: { top: 540, right: 292, bottom: 568, left: 220 },
      boundary: { top: 180, right: 312, bottom: 608, left: 68 }
    })).toEqual({ placement: 'top', maxHeight: 320, width: 228, alignRight: true });
  });
});
