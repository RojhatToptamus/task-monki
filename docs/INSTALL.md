# Installing Task Monki

Date: 2026-07-12

Task Monki is distributed through GitHub Releases as unsigned desktop builds.
macOS app bundles are ad-hoc signed only to preserve bundle integrity; they are
not Developer ID signed or notarized yet. The app does not include an automatic
updater. To update, download and install the newer release from GitHub.

## Requirements

Install these before using Task Monki:

- Git
- at least one supported coding-agent runtime, installed and authenticated:
  - Codex CLI with a compatible App Server;
  - OpenCode `>=1.4.0` and `<2.0.0` with one or more configured model providers;
  - an ACP profile: Gemini CLI, Grok Build, Cursor Agent, or
    `claude-agent-acp`;
- Optional: GitHub CLI, installed and authenticated, for branch publishing and
  draft pull-request features

Task Monki does not bundle Git, agent runtimes, or GitHub CLI. Packaged desktop
apps probe each registered runtime independently. One unavailable runtime does
not prevent another from working. Authentication and upstream model-provider
configuration remain owned by the selected runtime.

Settings provides custom executable paths for Git, GitHub CLI, Codex CLI,
OpenCode, and every registered ACP runtime. Use Auto-detect to return a saved
path to environment-override and then PATH-based discovery.

Environment variables are supported as debug overrides and take precedence over
saved Settings values:

```sh
TASK_MANAGER_GIT_PATH=/path/to/git
TASK_MONKI_CODEX_BIN=/path/to/codex
TASK_MONKI_OPENCODE_BIN=/path/to/opencode
TASK_MONKI_GEMINI_ACP_BIN=/path/to/gemini
TASK_MONKI_GROK_ACP_BIN=/path/to/grok
TASK_MONKI_CURSOR_AGENT_ACP_BIN=/path/to/cursor-agent
TASK_MONKI_CLAUDE_AGENT_ACP_BIN=/path/to/claude-agent-acp
TASK_MANAGER_GH_PATH=/path/to/gh
```

Git and one ready agent runtime are required to run a task. GitHub CLI is
optional; GitHub delivery features report it as unavailable when `gh` cannot
be resolved.

Codex and OpenCode are native integrations. ACP profiles are distinct runtime
integrations, not interchangeable model-provider shims. Their model choices,
session configuration, permission requests, and protocol capabilities are
reported separately in the runtime catalog. The browser development server
only enables runtimes that attest its stronger isolation boundary; use the
packaged Electron app for OpenCode and current ACP profiles.

## Downloads

Download the latest desktop build from
[GitHub Releases](https://github.com/RojhatToptamus/task-monki/releases/latest).

Use the asset that matches your platform:

| Platform | Asset |
| --- | --- |
| macOS Apple silicon | `Task-Monki-<version>-mac-arm64.dmg` or `.zip` |
| macOS Intel | `Task-Monki-<version>-mac-x64.dmg` or `.zip` |
| Windows | `Task-Monki-<version>-win-x64.exe` |
| Linux universal | `Task-Monki-<version>-linux-x86_64.AppImage` |
| Debian/Ubuntu | `Task-Monki-<version>-linux-amd64.deb` |

## Unsigned Build Warnings

The current release channel is unsigned:

- macOS may show a Gatekeeper warning because the app is not Developer ID
  signed or notarized yet.
- Windows may show an unknown-publisher or SmartScreen warning.
- Linux AppImage users may need to mark the file executable before launching.

### macOS unsigned alpha

This alpha is not Apple Developer ID signed or notarized yet.

If macOS blocks the app, use Apple's documented manual override flow:

1. Try opening `Task Monki.app` once.
2. Open System Settings -> Privacy & Security.
3. Scroll to Security.
4. Click Open Anyway for Task Monki.
5. Confirm with your password or Touch ID.

Apple says the Open Anyway button is available for about an hour after you try
to open the app. See
[Apple's guide to opening an app from an unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

If there is no Open Anyway button, or Task Monki starts but stays stuck on the
Dock with no window, quit the stuck `Task Monki` process and run:

```sh
xattr -dr com.apple.quarantine "/Applications/Task Monki.app"
open "/Applications/Task Monki.app"
```

Only install releases from the project's GitHub Releases page. Check
`SHA256SUMS-*.txt` when you need to verify a downloaded artifact.

## Updating

Updates are manual:

1. Open the latest GitHub Release.
2. Download the artifact for your platform.
3. Quit Task Monki.
4. Install or replace the app with the newer artifact.
5. Launch Task Monki again.

The app has a stable package identity, so manual upgrades should preserve the
same app data directory across versions on the same platform.

Task Monki stores durable app preferences, including runtime/model defaults,
repository selection, Codex tool modes, and configured executable paths, in
`app-settings.json` under the platform application data directory. Task and
evidence records are stored separately.

## First Launch

Task Monki opens without a selected repository in packaged builds. Add a local
Git repository from the repository menu before creating tasks. Use only
repositories you can recover, because Task Monki creates worktrees, commits,
branches, and optional draft pull requests when you explicitly ask it to.
