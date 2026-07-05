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
  disabled?: boolean;
  disabledReason?: string;
  app?: OpenTargetDetectedApp;
}

export interface OpenTargetMenuModel {
  primary: OpenTargetMenuItem;
  openWith: OpenTargetMenuItem[];
  utilities: OpenTargetMenuItem[];
}

export interface ViewportSize {
  width: number;
  height: number;
}

const MENU_MARGIN = 8;
const ESTIMATED_MENU_WIDTH = 292;
const ESTIMATED_MENU_HEIGHT = 340;

export function buildOpenTargetMenuModel(
  inspection: OpenTargetInspection
): OpenTargetMenuModel {
  const preferredApp = appById(inspection.apps, inspection.preferredAppId);
  const hasPreferredIde = preferredApp && preferredApp.id !== 'default';
  const primary: OpenTargetMenuItem = hasPreferredIde
    ? {
        id: `open:${preferredApp.id}`,
        label: `Open in ${preferredApp.label}`,
        action: 'open',
        appId: preferredApp.id,
        disabled: !inspection.canOpen,
        disabledReason: inspection.disabledReason,
        app: preferredApp
      }
    : {
        id: 'open:default',
        label: 'Open in default app',
        action: 'open',
        appId: 'default',
        disabled: !inspection.canOpen,
        disabledReason: inspection.disabledReason,
        app: preferredApp
      };

  const openWith: OpenTargetMenuItem[] = inspection.apps
    .filter((app) => app.id !== 'default' && app.id !== preferredApp?.id)
    .map((app) => ({
      id: `openWith:${app.id}`,
      label: app.label,
      action: 'open' as const,
      appId: app.id,
      disabled: !inspection.canOpen,
      disabledReason: inspection.disabledReason,
      app
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

export function openTargetMenuPosition(
  x: number,
  y: number,
  viewport: ViewportSize | undefined = browserViewport()
): { x: number; y: number } {
  if (!viewport) {
    return { x, y };
  }
  return {
    x: Math.max(
      MENU_MARGIN,
      Math.min(x, Math.max(MENU_MARGIN, viewport.width - ESTIMATED_MENU_WIDTH))
    ),
    y: Math.max(
      MENU_MARGIN,
      Math.min(y, Math.max(MENU_MARGIN, viewport.height - ESTIMATED_MENU_HEIGHT))
    )
  };
}

function appById(
  apps: OpenTargetDetectedApp[],
  appId: OpenTargetAppId
): OpenTargetDetectedApp | undefined {
  return apps.find((app) => app.id === appId);
}

function browserViewport(): ViewportSize | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return { width: window.innerWidth, height: window.innerHeight };
}
