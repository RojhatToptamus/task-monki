# Releasing Task Monki

Date: 2026-07-11

Task Monki's current release channel uses unsigned artifacts attached to draft
GitHub Releases. It does not use trusted Developer ID code signing,
notarization, package-manager publishing, or automatic updates. macOS app
bundles are ad-hoc signed only to preserve bundle integrity before DMG/ZIP
packaging.

## Release Artifacts

The release workflow builds:

- macOS: `dmg` and `zip` for `x64` and `arm64`
- Windows: NSIS installer `exe` for `x64`
- Linux: `AppImage` and `deb` for `x64`
- checksums: `SHA256SUMS-macOS.txt`, `SHA256SUMS-Windows.txt`,
  `SHA256SUMS-Linux.txt`

The stable app identity is `dev.taskmonki.desktop`. Do not change it without a
data-migration plan, because app identity affects where desktop platforms store
application data and how manual upgrades relate to previous installs.

macOS packaging uses `build/icon.icns` for the bundle icon and also copies
`build/icon.png` to `Contents/Resources/icon.png`. The main process sets the
Dock tile from that PNG at runtime so macOS shows the original full-canvas logo
instead of a cached or inset fallback. Do not regenerate or pad these icon
assets casually; keep the original logo geometry intact.

## Local Verification Before Tagging

Run the full repository checks:

```sh
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```

Build an unpacked app for the current platform:

```sh
npm run dist:dir
```

On macOS, verify the unpacked bundle and confirm generic resources do not carry
detached code-signature extended attributes. Also confirm the root bundle is
ad-hoc signed without Hardened Runtime:

```sh
codesign --verify --deep --strict --verbose=4 "release/mac-arm64/Task Monki.app"
codesign -dvvv "release/mac-arm64/Task Monki.app"
if xattr -lr "release/mac-arm64/Task Monki.app" | grep -q 'com\.apple\.cs\.Code'; then
  echo "unexpected detached code-signature xattrs"
  exit 1
fi
```

The `codesign -dvvv` output should show `Signature=adhoc` and flags containing
`adhoc`, not `runtime`, for this unsigned alpha channel.

`spctl --assess` can still reject ad-hoc signed alpha builds, or report an
internal Code Signing subsystem error, because they are not Developer ID signed
or notarized. On current macOS, quarantined GitHub downloads may be blocked
before Electron starts. That is a trust-policy failure, not a renderer failure.
For this unsigned channel, the launch check is that the app verifies with
`codesign`, has no detached `com.apple.cs.*` resource xattrs, and opens a
renderer window after Gatekeeper is overridden through System Settings or the
quarantine fallback is removed. If macOS needs normal double-click launch from
a downloaded artifact, ship a Developer ID signed and notarized build instead
of this alpha signing path.

The custom ad-hoc signing hook must not sign generic resource blobs such as
`app.asar`, icons, Chromium `.pak` files, `.dat` files, `.nib` files, or V8
snapshot `.bin` files. They are sealed by the containing bundle signature, not
signed as standalone code. The release build intentionally fails if those files
receive detached `com.apple.cs.*` extended attributes again.

The unsigned alpha macOS configuration also disables Hardened Runtime. Hardened
Runtime belongs to a Developer ID signed and notarized release configuration;
combined with ad-hoc signing it can leave macOS-launched Electron builds stuck
before helper processes start.

Smoke test only against a throwaway local Git repository:

1. Launch the unpacked app.
2. Confirm the renderer loads.
3. Open Settings and confirm Git and Codex CLI report available tool status.
4. Confirm Auto-detect shows resolved paths and live versions.
5. Confirm a custom invalid GitHub CLI path reports `gh` as unavailable without
   blocking Git or Codex, then reset it to Auto-detect.
6. Add the throwaway repository.
7. Validate the repository.
8. Create a smoke task and prepare a worktree.
9. Do not push branches or create real pull requests during release smoke tests.

## Creating A Draft Release

1. Update `package.json` version.
2. Update release notes or changelog content as needed.
3. Commit the release prep.
4. Confirm `git status` is clean and the current commit is the release-prep
   commit.
5. Create and push a tag that matches the release workflow trigger:

```sh
git tag v0.1.0-alpha.1
git show --no-patch --oneline v0.1.0-alpha.1
git push origin v0.1.0-alpha.1
```

The tag must point at the committed release-prep change. The workflow builds the
tagged commit, not whatever happens to be on `main` later.

The GitHub Actions release workflow runs on tags matching
`v[0-9]+.[0-9]+.[0-9]+*`. It creates a draft GitHub Release and uploads the
unsigned artifacts.

For an alpha, beta, or release-candidate build, mark the GitHub draft as a
pre-release before publishing it.

## Draft Release Review

Before publishing the draft:

- Confirm every expected platform artifact uploaded.
- Confirm checksum files uploaded.
- Download at least the current-platform artifact from GitHub and launch it.
- Confirm release notes clearly state the artifacts are unsigned; macOS is
  ad-hoc signed only and is not Developer ID signed or notarized.
- Confirm macOS release notes use Apple's System Settings -> Privacy & Security
  Open Anyway flow as the primary workaround, and list the quarantine removal
  command from `docs/INSTALL.md` only as a fallback for missing Open Anyway
  buttons or stuck no-window launches.
- Confirm release notes link to `docs/INSTALL.md`.
- Confirm manual update instructions are present.
- Confirm known limitations mention no trusted signing, notarization,
  package-manager publishing, or automatic updater yet.

Use grouped download sections in the release notes so users do not have to
interpret GitHub's flat asset list:

```md
## Downloads

### macOS

- Apple silicon: `Task-Monki-<version>-mac-arm64.dmg`
- Intel: `Task-Monki-<version>-mac-x64.dmg`

#### macOS unsigned alpha

This alpha is not Apple Developer ID signed or notarized yet. If macOS blocks
the app, try opening `Task Monki.app` once, then open System Settings -> Privacy
& Security, scroll to Security, click Open Anyway for Task Monki, and confirm
with your password or Touch ID. Apple says Open Anyway is available for about an
hour after the first blocked open attempt. See
[Apple's guide to opening an app from an unknown developer](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

If there is no Open Anyway button, or Task Monki starts but no window appears,
quit the stuck `Task Monki` process and run:

```sh
xattr -dr com.apple.quarantine "/Applications/Task Monki.app"
open "/Applications/Task Monki.app"
```

For this unsigned alpha, keep this fallback visible in the release notes. On
current macOS, Open Anyway can still leave an ad-hoc Electron build stuck at the
Dock icon with no renderer window until the quarantine attribute is removed.

### Windows

- `Task-Monki-<version>-win-x64.exe`

### Linux

- AppImage: `Task-Monki-<version>-linux-x86_64.AppImage`
- Debian/Ubuntu: `Task-Monki-<version>-linux-amd64.deb`

### Checksums

- `SHA256SUMS-macOS.txt`
- `SHA256SUMS-Windows.txt`
- `SHA256SUMS-Linux.txt`
```

Keep the platform artifact names clear and leave generated `.blockmap` and
`latest-*.yml` assets attached for this alpha. They are normal electron-builder
metadata, but they should not be presented as primary downloads in the notes.
