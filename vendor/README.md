# Previewhost runtime

`previewhost.tgz` contains Previewhost 0.5.1 with the supervisor diagnostic and readiness repairs used by Task Monki. It is a local, unpublished package built from the Previewhost source repository. Keeping the archive here makes `npm ci` and packaged builds reproducible without an absolute path or a modified `node_modules` tree.

The source starts at Previewhost commit `4d0a097` (runtime source identical to release 0.5.0) with these changes: capture redacted supervisor bootstrap output, distinguish `SUPERVISOR_FAILED`, share the existing stream redactor, and classify HTTP readiness expiry as `TIMEOUT`.

To rebuild after changing Previewhost, run `npm run build` and `npm pack --ignore-scripts` in that repository. Copy the resulting package to `vendor/previewhost.tgz`, then run `npm install ./vendor/previewhost.tgz` here. Run the Preview tests and `npm run dist:dir && npm run verify:packaged-preview` before shipping it. Replace the file dependency with the published release when those source changes are released.
