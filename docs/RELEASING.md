# Releasing Task Monki

Date: 2026-06-30

Task Monki's MVP release channel uses unsigned artifacts attached to draft
GitHub Releases. Code signing, notarization, package-manager publishing, and
automatic updates are intentionally out of scope for this phase.

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
- Confirm release notes clearly state the artifacts are unsigned.
- Confirm release notes link to `docs/INSTALL.md`.
- Confirm manual update instructions are present.
- Confirm known limitations mention no signing, notarization, package-manager
  publishing, or automatic updater yet.

## Future Signed Release Work

Add signing in a separate change from the unsigned MVP:

- macOS: Developer ID Application certificate, hardened runtime, notarization,
  stapling, and signing validation.
- Windows: code-signing certificate or trusted signing service, plus timestamped
  signatures.
- CI: add signing secrets and set `forceCodeSigning: true` only after signed
  builds are required.

Automatic updates should also be a separate change. Use a prompted update flow,
not forced restarts, because Task Monki can have active Codex App Server runs,
Git operations, GitHub delivery operations, and local worktrees.
