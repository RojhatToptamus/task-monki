# Releasing Task Monki

Date: 2026-08-26

Task Monki publishes one stable GitHub Release for all supported desktop
platforms. The first stable release is `0.2.0` with tag `v0.2.0`.

The release contains these user installers and update files:

| Platform | User installer | Update files |
| --- | --- | --- |
| macOS 14 or newer, Apple silicon | `Task-Monki-<version>-mac-arm64.dmg` | ZIP, ZIP blockmap, and `latest-mac.yml` |
| Windows 10 or newer, x64 | `Task-Monki-<version>-win-x64.exe` | installer blockmap and `latest.yml` |
| x64 Linux with AppImage support | `Task-Monki-<version>-linux-x86_64.AppImage` | `latest-linux.yml` |

Each platform also has a SHA-256 checksum file. GitHub Releases is the single
download and update source. There is no update redirect or separate feed.

## Trust model

The macOS app uses this Developer ID identity:

`Developer ID Application: rojhat toptamus (ZD35XP4V7D)`

The workflow enables Hardened Runtime. It signs the app, submits the DMG to
Apple, and records the submission ID before waiting. After Apple accepts the
submission, the workflow staples and validates the DMG and app. It then creates
the ZIP from the final stapled app. Gatekeeper checks run on the DMG and mounted
app.

Windows releases are temporarily unsigned. The first install can show
SmartScreen or **Unknown Publisher**. A user can select **More info**, then
**Run anyway**. The updater does not require an Authenticode publisher while
this policy is active. The workflow still checks the installer structure,
version, x64 architecture, update metadata, blockmap, SHA-256 value, and final
release asset set.

This is a deliberate temporary trade-off. An attacker who can replace release
files would not need a Windows signing key. Protected tags, immutable GitHub
Releases, draft-first publishing, metadata hashes, and public download checks
reduce that risk. They do not provide publisher identity. Do not add a Windows
certificate, signing secret, Azure signing service, or Authenticode gate for
the initial release.

When Windows signing is added, keep the same NSIS updater. Configure the
publisher identity, sign the installer and application, remove
`win.verifyUpdateCodeSignature: false`, and add an Authenticode check. Do these
changes together.

The Linux AppImage is unsigned. Its update metadata and SHA-512 download digest
detect corrupted or replaced update bytes. The GitHub Release checks protect
the published asset set. They do not provide a Linux publisher signature.

## Release controls

The protected `release` environment holds only the macOS secrets:

- `MACOS_CERTIFICATE_P12`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY_P8`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`

Do not copy these values to repository secrets, workflow inputs, logs, or local
files. The macOS job creates a temporary keychain and temporary API-key file.
It removes the certificate input immediately after import. It removes the API
key immediately after the Apple wait and log request. A final cleanup step also
restores the original keychain search list and removes all temporary credential
files.

The `release` environment must:

- require approval from `@RojhatToptamus`;
- accept only `main` and tags that match `v*`;
- prevent administrator approval bypass.

The repository must protect `v*` tags from update or deletion. Keep GitHub
immutable releases enabled. Protect `main` with code-owner review and dismiss
approvals after new commits. Allow only GitHub-owned Actions and require full
commit SHAs.

The workflow grants read-only repository access by default. Only the tag-only
publish job receives `contents: write`. Windows and Linux jobs do not use the
`release` environment or any signing secret.

## Version rules

`package.json` owns the version. A release version must have the stable
`MAJOR.MINOR.PATCH` form. `package-lock.json` must contain the same version. The
tag must be `v` plus that exact version.

The release commit must be on `main`. The workflow rejects a mismatched tag or
an existing GitHub Release. The GitHub Actions run number becomes the macOS
`CFBundleVersion`. The package version becomes the user-visible version on all
platforms.

## Local checks

Before release preparation is merged, run:

```sh
npm ci
npm run verify
npx vitest run scripts/verify-release-artifacts.test.mjs
git diff --check
```

These checks need no release credential. Local builds must not contact Apple.

## Complete dry run

Run a manual dry run from `main` before the first release. Also run one after a
release-pipeline change.

1. Open the **Trusted desktop release** workflow.
2. Run it on `main`.
3. Check the source commit in the pending `release` deployment.
4. Approve the macOS job.

The dry run uses the same validation, build, signing, notarization, packaging,
and internal verification jobs as production. It builds all three platforms.
It does not create a tag, commit, branch, GitHub Release, or public asset.

Accept the dry run only when:

- the source and repository quality gates pass;
- macOS reports one accepted Apple submission ID;
- the DMG and mounted app pass signing, timestamp, Hardened Runtime, stapler,
  Gatekeeper, entitlement, architecture, and packaged-runtime checks;
- the final macOS ZIP contains the stapled signed app;
- the Windows NSIS and Linux AppImage checks pass;
- each fresh verifier downloads one exact internal artifact set;
- all checksums and update-metadata digests match;
- the publish and public-verification jobs are skipped.

Internal release artifacts expire after one day. The Apple notarization log
expires after seven days.

## Production release

1. Set the stable version in `package.json` and `package-lock.json`.
2. Update release notes and run the local checks.
3. Merge the release preparation to `main`.
4. Confirm that all required checks pass on the intended commit.
5. Create and push the matching tag.

For the first stable release:

```sh
git switch main
git pull --ff-only
git tag v0.2.0
git show --no-patch --oneline v0.2.0
git push origin v0.2.0
```

Check the pending environment deployment before approval. The workflow creates
a draft Release only after all internal checks pass. It uploads the complete
asset set, downloads it again, verifies it, publishes the draft, and marks it
as the latest release. Only then can installed apps discover the update.

Accept production only when:

- every dry-run acceptance condition also passes in the tag run;
- the tag still resolves to the validated `main` commit;
- the Release contains exactly the twelve expected assets;
- GitHub reports the published Release as immutable;
- fresh public verifiers download without authentication;
- public checksums, metadata, architecture, and asset integrity pass;
- the public macOS DMG and ZIP pass the complete Apple trust checks.

## Failure handling

The macOS job records the Apple submission ID before it waits. If Apple rejects
the submission, download the `notarization-log-*` artifact. Inspect its issue
paths.

Do not replace a verified artifact. Do not move or force-push a release tag. If
source or artifact bytes are wrong, fix the source and use a new version.

Do not manually add a release asset after publication. The public verifier
requires the exact asset set. If publishing leaves a draft Release, inspect it,
delete only that draft, and rerun the complete tag workflow. Do not delete or
move the tag. A failure after publication needs investigation before a new
release.

## Independent public checks

Download `SHA256SUMS-<platform>.txt` and the platform files from the matching
GitHub Release. Check the SHA-256 values before installation.

On macOS, also run:

```sh
version=0.2.0
dmg="Task-Monki-${version}-mac-arm64.dmg"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$dmg" \
  "https://github.com/RojhatToptamus/task-monki/releases/download/v${version}/${dmg}"
hdiutil verify "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
```

The automated public checks also verify the update metadata and the
downloaded public installer on its target operating system.
