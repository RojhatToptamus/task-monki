import type {
  OpenTargetAction,
  OpenTargetAppId,
  OpenTargetDetectedApp,
  OpenTargetInspection
} from '../../shared/contracts';

export interface OpenTargetMenuItem {
  id: string;
  label: string;
  action: OpenTargetAction;
  appId?: OpenTargetAppId;
  /** A short muted value on the item's line: the app Open uses, or Default in Open with. */
  meta?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface OpenTargetMenuModel {
  /** Open, in the preferred app (named beside it) or the system's default app. */
  primary: OpenTargetMenuItem;
  /** Every app that can open the target, the preferred one first, then the terminal. */
  openWith: OpenTargetMenuItem[];
  utilities: OpenTargetMenuItem[];
}

/** Finder's grammar: Open uses the preferred app; Open with lists the alternatives. */
export function buildOpenTargetMenuModel(
  inspection: OpenTargetInspection
): OpenTargetMenuModel {
  const preferredApp = appById(inspection.apps, inspection.preferredAppId);
  const preferredIde = preferredApp && preferredApp.id !== 'default' ? preferredApp : undefined;
  const openState = { disabled: !inspection.canOpen, disabledReason: inspection.disabledReason };
  const primary: OpenTargetMenuItem = {
    id: 'open',
    label: 'Open',
    meta: preferredIde?.label,
    action: 'open',
    appId: preferredIde?.id ?? 'default',
    ...openState
  };

  const apps = inspection.apps.filter((app) => app.id !== 'default');
  const openWith: OpenTargetMenuItem[] = [
    ...(preferredIde ? [preferredIde] : []),
    ...apps.filter((app) => app.id !== preferredIde?.id)
  ].map((app) => ({
    id: `openWith:${app.id}`,
    label: app.label,
    meta: app.id === preferredIde?.id ? 'Default' : undefined,
    action: 'open' as const,
    appId: app.id,
    ...openState
  }));

  if (inspection.target.type === 'repository' || inspection.target.type === 'worktree') {
    openWith.push({
      id: 'openWith:terminal',
      label: 'Terminal',
      action: 'openTerminal',
      disabled: !inspection.canOpenTerminal,
      disabledReason: inspection.canOpenTerminal
        ? undefined
        : 'No supported terminal launcher was found.'
    });
  }

  const utilities: OpenTargetMenuItem[] = [
    {
      id: 'copyPath',
      label: 'Copy path',
      action: 'copyPath'
    }
  ];

  if (inspection.target.type === 'worktreeFile' && inspection.target.kind !== 'directory') {
    utilities.push({
      id: 'copyFileContents',
      label: 'Copy file contents',
      action: 'copyFileContents',
      disabled: !inspection.canCopyFileContents,
      disabledReason: inspection.copyFileContentsDisabledReason
    });
  }

  utilities.push(
    {
      id: 'reveal',
      label: inspection.revealLabel,
      action: 'reveal',
      disabled: !inspection.canReveal,
      disabledReason: inspection.canReveal ? undefined : 'No existing parent folder.'
    }
  );

  return { primary, openWith, utilities };
}

function appById(
  apps: OpenTargetDetectedApp[],
  appId: OpenTargetAppId
): OpenTargetDetectedApp | undefined {
  return apps.find((app) => app.id === appId);
}
