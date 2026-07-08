import { describe, expect, it } from 'vitest';
import type { OpenTargetInspection } from '../../shared/contracts';
import { buildOpenTargetMenuModel, openTargetMenuPosition } from './openTargetMenu';

describe('buildOpenTargetMenuModel', () => {
  it('uses the preferred detected IDE as the primary action', () => {
    const model = buildOpenTargetMenuModel(
      inspection({
        preferredAppId: 'cursor',
        targetType: 'worktree',
        apps: ['cursor', 'vscode', 'default']
      })
    );

    expect(model.primary).toMatchObject({
      label: 'Open in Cursor',
      action: 'open',
      appId: 'cursor'
    });
    expect(model.openWith.map((item) => item.label)).toEqual(['VS Code', 'Terminal']);
    expect(model.openWith.find((item) => item.id === 'openWith:terminal')).toMatchObject({
      action: 'openTerminal'
    });
    expect(model.utilities.map((item) => item.label)).not.toContain('Open in Terminal');
    expect(model.utilities.map((item) => item.label)).not.toContain('Copy file contents');
  });

  it('falls back to the system default app when no IDE is detected', () => {
    const model = buildOpenTargetMenuModel(
      inspection({
        preferredAppId: 'default',
        targetType: 'worktree',
        apps: ['default']
      })
    );

    expect(model.primary).toMatchObject({
      label: 'Open in default app',
      action: 'open',
      appId: 'default'
    });
    expect(model.openWith.map((item) => item.label)).toEqual(['Terminal']);
  });

  it('keeps copy file contents disabled with the core-provided reason', () => {
    const model = buildOpenTargetMenuModel(
      inspection({
        canCopyFileContents: false,
        copyFileContentsDisabledReason: 'Target is not a file.'
      })
    );

    expect(model.utilities.find((item) => item.id === 'copyFileContents')).toMatchObject({
      disabled: true,
      disabledReason: 'Target is not a file.'
    });
  });

  it('clamps floating menu coordinates inside the viewport', () => {
    expect(openTargetMenuPosition(900, 700, { width: 960, height: 720 })).toEqual({
      x: 668,
      y: 380
    });
    expect(openTargetMenuPosition(20, 30, { width: 960, height: 720 })).toEqual({
      x: 20,
      y: 30
    });
    expect(openTargetMenuPosition(0, 0, { width: 240, height: 260 })).toEqual({
      x: 8,
      y: 8
    });
  });
});

function inspection(input: {
  preferredAppId?: OpenTargetInspection['preferredAppId'];
  targetType?: OpenTargetInspection['target']['type'];
  apps?: Array<'cursor' | 'vscode' | 'default'>;
  canCopyFileContents?: boolean;
  copyFileContentsDisabledReason?: string;
} = {}): OpenTargetInspection {
  return {
    target: {
      type: input.targetType ?? 'worktreeFile',
      kind: 'file'
    },
    preferredAppId: input.preferredAppId ?? 'cursor',
    apps: (input.apps ?? ['cursor', 'default']).map((id) => ({
      id,
      label: id === 'cursor' ? 'Cursor' : id === 'vscode' ? 'VS Code' : 'Default app',
      icon: id === 'default' ? undefined : { kind: 'image', dataUrl: `data:image/png;base64,${id}` }
    })),
    revealLabel: 'Reveal in Finder',
    canOpen: true,
    canReveal: true,
    canOpenTerminal: true,
    canCopyFileContents: input.canCopyFileContents ?? true,
    copyFileContentsDisabledReason: input.copyFileContentsDisabledReason
  };
}
