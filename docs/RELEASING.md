# Releasing Task Monki for macOS

Date: 2026-08-26

Task Monki publishes one trusted macOS artifact for Apple silicon:

`Task-Monki-<version>-mac-arm64.dmg`

The release workflow signs the app with this Developer ID identity:

`Developer ID Application: rojhat toptamus (ZD35XP4V7D)`

It enables Hardened Runtime, submits the DMG to Apple, staples the ticket, and
checks the DMG and mounted app with Gatekeeper. The workflow publishes no ZIP,
Windows, or Linux artifacts. Updates remain manual.

## Release controls

The `release` environment holds these secrets:

- `MACOS_CERTIFICATE_P12`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY_P8`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`

Do not put these values in repository secrets, workflow inputs, logs, or local
release files. The workflow writes the certificate and Apple API key only to
temporary runner files. It deletes those files after use.

The `release` environment must:

- require approval from `@RojhatToptamus`.
- reject deployments from branches other than `main`.
- accept release tags that match `v*`.
- prevent administrator approval bypass.

The repository must prevent updates and deletion of tags that match `v*`.
GitHub immutable releases must stay enabled.
Protection for `main` must require code-owner review and dismiss an approval
when a new commit is pushed.
After this workflow reaches `main`, allow only GitHub-owned actions. Also
require every action reference to use a full commit SHA.

## Version rules

`package.json` owns the release version. Supported versions have one of these
forms:

```text
1.2.3
1.2.3-alpha.1
1.2.3-beta.1
1.2.3-rc.1
```

For a production run, the tag must be `v` plus the exact package version. The
tag commit must be on `main`. The workflow rejects an existing release tag.

The macOS user-visible bundle version contains only the numeric part. For
example, `0.2.0-alpha.2` becomes `0.2.0`. The GitHub Actions run number becomes
`CFBundleVersion`.

## Local checks

Before you merge release preparation, run:

```sh
npm ci
npm run verify
git diff --check
```

These checks need no release credentials. Normal local and pull-request builds
continue to use the development packaging configuration. They do not use the
Developer ID certificate or contact Apple.

## Complete dry run

Use a manual dry run before the first production release and after a release
pipeline change:

1. Merge the release code to `main`.
2. Open the `Trusted macOS release` workflow in GitHub Actions.
3. Select **Run workflow** on `main`.
4. Review the pending `release` environment deployment.
5. Confirm that the source commit is the intended `main` commit.
6. Approve the deployment.

The dry run executes the production build, signing, runtime probes,
notarization, stapling, Gatekeeper checks, checksum creation, upload, and a
fresh-runner download verification. It does not create a tag, commit, branch,
GitHub Release, or public asset.

Accept the dry run only when:

- all executed jobs finish successfully.
- the build job reports one Apple submission ID.
- Apple returns `Accepted`.
- the internal verifier downloads exactly the DMG and its checksum.
- the checksum matches after download.
- the DMG and mounted app pass signature, Hardened Runtime, entitlement,
  architecture, stapler, and Gatekeeper checks.
- the signed Electron and Design browser runtime probes pass.
- the publish and public-verification jobs are skipped.

The internal artifact expires after one day. The Apple notarization log expires
after seven days.

## Production release

1. Set the next unused version in `package.json` and `package-lock.json`.
2. Update release notes as needed.
3. Run the local checks.
4. Merge the release preparation to `main`.
5. Confirm that the `main` commit is correct and all required checks pass.
6. Create the matching tag on that commit.
7. Push only that tag.

Example:

```sh
git switch main
git pull --ff-only
git tag v0.2.0-alpha.2
git show --no-patch --oneline v0.2.0-alpha.2
git push origin v0.2.0-alpha.2
```

Review the pending `release` environment deployment. Confirm the source commit
and tag before approval.

The workflow publishes only after the fresh-runner internal verification
passes. It creates the GitHub Release from the existing tag and uploads only
the verified DMG. Alpha, beta, and release-candidate versions become GitHub
pre-releases.

Accept the production release only when:

- the dry-run acceptance checks pass in the tag run.
- the tag still resolves to the validated source commit.
- the publishing job creates one immutable GitHub Release.
- the release contains exactly the expected DMG.
- the public-verification job downloads the DMG without authentication.
- the public DMG matches the build job's SHA-256 value.
- GitHub verifies the release and asset.
- the public DMG and mounted app pass the full trusted macOS verifier.

## Failure handling

The build job records the Apple submission ID before it waits. If Apple rejects
the submission or the wait fails, download the `notarization-log-*` workflow
artifact and inspect its reported issue paths.

Do not replace a notarized internal artifact or a public release asset. Do not
move or force-push a release tag. Fix the source, choose a new package version,
and run the release again.

If a transient download or GitHub API error causes the failure, rerun only the
public-verification job. If the published bytes or trust checks are wrong, use
a new version.

## Independent public check

Anyone with an Apple silicon Mac can verify a published DMG:

```sh
version=0.2.0-alpha.2
dmg="Task-Monki-${version}-mac-arm64.dmg"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$dmg" \
  "https://github.com/RojhatToptamus/task-monki/releases/download/v${version}/${dmg}"
hdiutil verify "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
```

The automated public-verification job also mounts the DMG. It checks the app's
Developer ID chain, Team ID, secure timestamps, Hardened Runtime, minimal
entitlements, arm64-only code, bundle metadata, and Gatekeeper acceptance.
