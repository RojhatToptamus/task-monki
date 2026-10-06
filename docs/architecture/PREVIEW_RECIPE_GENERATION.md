# Preview configuration generation

Task Monki can prepare root `preview.yaml` when a task has no configuration.
Generation is an authoring aid. Previewhost remains the parser and runtime owner;
the agent cannot authorize execution.

## User flow and write boundary

**Generate with agent** opens the existing review modal with progress, YAML, and
an evidence report. The user can edit, regenerate, discard, or close the draft.
If evidence is insufficient, the agent asks up to three focused questions.
The user can supply nonsecret clarification and regenerate. Clarification records
user decisions, not repository evidence or permission to run commands.
Task Monki rejects likely secret values before it sends clarification to the provider.
Closing does not modify the repository. **Save configuration** validates the
reviewed text and exclusively creates `preview.yaml`. It refuses an existing
`preview.yaml` or `preview.yml`, including a file created during review.
Acceptance does not approve or start the application.

Validation uses Previewhost's `parsePreviewSpec` after strict YAML parsing. Drafts
are limited to 64 KiB. Unknown fields, aliases, duplicate keys, malformed reports,
secret-like literal environment values, implicit package acquisition, and commands
that conflict with trusted framework evidence are rejected. Validation errors use
fixed messages instead of echoing unsafe source snippets.

## Evidence and model output

`PreviewRecipeGenerationSupport.ts` owns the agent authoring instructions and
parser-tested examples. `PreviewFrameworkCapabilities` derives narrow command and
package preparation facts from sanitized manifests. Supported Next.js commands
must consume the allocated port; fixed ports or HTTPS arguments are changed only
when the derived capability supplies an exact compatible command and review
comment. Unknown commands are reported as insufficient evidence.

Native commands can consume the injected `PORT` and `HOST`, or use evidenced
command-line flags with `{port}` or `{port:NAME}`. Generation must prove the
listener behavior from source or derived framework facts. HTTP readiness accepts
status 200–399 response headers without following redirects or checking bodies.
Workers require an evidenced HTTP, TCP, or command probe.

An evidenced npm installation is an explicit job with the required `dependsOn`
edge. Its review comment identifies package lifecycle execution. Generation must
not silently acquire packages through `npx`, `npm exec`, or package-manager `dlx`.

Public environment candidates come from bounded source inspection and explicitly
tracked templates. Each candidate needs one report decision: attach a service,
keep an evidenced source default, or omit it. Conflicting targets produce an
unconfigured attachment, not a guessed endpoint. Secret values use named
Previewhost references on their exact recipients.
Generation does not use `fromEnv`: the embedded runtime supplies no owner inputs.

The result is one bounded JSON object containing a draft or insufficient-evidence
status, summary, evidence, assumptions, omissions, unresolved decisions, and public
environment decisions. Evidence paths must name inspected files. Task Monki may
accept bounded non-JSON progress before the final object, but rejects multiple
objects or trailing commentary.

## Inspection and lifecycle

The provider receives an app-owned disposable evidence directory, not the live
worktree. Inspection excludes symlinks, likely secret-bearing paths, actual `.env`
files, binary files, dependencies, generated content, and oversized content.
Lockfile and template parsers return restricted metadata rather than raw files.
This reduces disclosure but does not make arbitrary committed source secret-free.

The selected provider must support the generation capability. Its turn uses the
existing restricted permission mapping, sanitized environment, bounded output,
and deadline. Instructions forbid application, test, Docker, network, and
repository command execution. The provider's normal cancellation and process
recovery mechanisms remain authoritative; this is not a new agent runtime.

Drafts live in main-process memory. One generation can run per task. Regeneration
keeps the last valid draft until replacement succeeds. Deletion and shutdown cancel
and join generation. Uncertain termination retains the existing provider recovery
record and evidence directory until cleanup succeeds. Draft acceptance rechecks
the current task and worktree identity, captured capability facts, and safe file
creation boundaries. It does not inspect fresh repository contents. Regeneration
captures new evidence after source changes.
