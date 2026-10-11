import { describe, expect, it } from 'vitest';
import type { OpenTargetInspection } from '../../shared/contracts';
import { buildOpenTargetMenuModel } from './openTargetMenu';

describe('buildOpenTargetMenuModel', () => {
  it('opens in the preferred IDE and lists it first, as the default, in Open with', () => {
    const model = buildOpenTargetMenuModel(
      inspection({
        preferredAppId: 'cursor',
        targetType: 'worktree',
        apps: ['cursor', 'vscode', 'default']
      })
    );

    expect(model.primary).toMatchObject({
      label: 'Open',
      meta: 'Cursor',
      action: 'open',
      appId: 'cursor'
    });
    expect(model.openWith.map((item) => item.label)).toEqual(['Cursor', 'VS Code', 'Terminal']);
    expect(model.openWith[0]).toMatchObject({ meta: 'Default', appId: 'cursor' });
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
      label: 'Open',
      action: 'open',
      appId: 'default'
    });
    expect(model.primary.meta).toBeUndefined();
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
      label: id === 'cursor' ? 'Cursor' : id === 'vscode' ? 'VS Code' : 'Default app'
    })),
    revealLabel: 'Reveal in Finder',
    canOpen: true,
    canReveal: true,
    canOpenTerminal: true,
    canCopyFileContents: input.canCopyFileContents ?? true,
    copyFileContentsDisabledReason: input.copyFileContentsDisabledReason
  };
}
