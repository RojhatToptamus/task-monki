# Window Chrome

Date: 2026-07-05

Task Monki uses Electron custom titlebar regions while preserving native window
controls and platform titlebar behavior.

## macOS

- The main window uses `titleBarStyle: "hiddenInset"` with native traffic-light
  controls.
- The native controls are recentered from the current web-content zoom factor
  whenever the renderer viewport scale changes, keeping them on the same
  vertical centerline as the app titlebar buttons.
- The renderer topbar is a draggable Electron titlebar region. The app
  deliberately delegates double-clicks in that draggable region to native macOS
  titlebar behavior, respecting the user's Desktop & Dock setting: Fill, Zoom,
  Minimize, or No Action.
- Do not map topbar double-click to fullscreen. Fullscreen belongs to the
  native green control and system menu behavior.
- Interactive controls inside the topbar must opt out of dragging with
  `-webkit-app-region: no-drag`.

## Windows And Linux

- The main window uses `titleBarStyle: "hidden"` plus `titleBarOverlay` so
  native window controls remain exposed.
- The renderer topbar remains the draggable titlebar region. The app
  deliberately delegates double-clicks in that draggable region to platform
  non-client titlebar behavior, which should toggle maximize/restore.
- The topbar reserves the Electron Window Controls Overlay safe area through
  `env(titlebar-area-*)` so app controls do not sit underneath native window
  controls.

## Implementation Notes

- Chrome options live in `src/electron/windowChrome.ts`.
- `src/electron/preload.ts` exposes a renderer platform label and a scoped
  request to resync native window chrome. Neither is workflow state and neither
  may affect task projections.
- Do not add renderer double-click handlers to draggable titlebar regions.
  Electron drag regions intentionally suppress normal pointer events, and the
  OS should own titlebar double-click behavior.
