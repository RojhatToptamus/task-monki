#!/bin/sh
set -eu

[ "${TASK_MONKI_RUN_PREVIEW_CREDENTIAL_GATE:-}" = "1" ] || {
  echo "Set TASK_MONKI_RUN_PREVIEW_CREDENTIAL_GATE=1 to run the managed-credential Docker smoke test." >&2
  exit 2
}

export TASK_MONKI_OCI_INTEGRATION=1
export TASK_MONKI_OCI_CONTEXT="${TASK_MONKI_OCI_CONTEXT:-desktop-linux}"
exec npm test -- src/core/preview/runtime/OciResourceRuntime.test.ts
