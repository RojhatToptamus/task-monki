# Preview Recipe Generation

Date: 2026-07-14

Task Monki can prepare a reviewable `.taskmonki/preview.yaml` draft when the
current task worktree has no Preview recipe. Generation is an authoring aid;
it does not change Preview's parser, plan, approval, or runtime authority.

## User flow

After **Check preview** confirms the recipe is missing, the Preview workspace
offers:

- **Generate with agent** — opens a persistent review modal immediately,
  displays generation progress, then shows the complete YAML and generation
  report;
- **Write manually** — opens the task worktree without creating a file.

The generated draft can be edited, regenerated, discarded, or closed. Close
leaves the repository unchanged and keeps the last generated draft in
main-process memory for the current app session. Discard cancels active
generation and removes the transient draft.

Only **Accept & save recipe** writes to the repository. Acceptance validates
the exact reviewed YAML, exclusively creates `.taskmonki/preview.yaml`, and
refuses to overwrite a file that appeared during review. It then invokes the
normal Preview resolve path. It never approves a plan or starts Preview.

## Generation support contract

The generator receives versioned support material from
`PreviewRecipeGenerationSupport.ts`:

- a stable behavioral instruction;
- the machine-readable `task-monki-preview-recipe-generation/v3` authoring
  contract;
- deterministic `task-monki-preview-framework-capabilities/v2` compatibility
  facts derived from sanitized repository manifests;
- parser-tested native, private-input/managed-data, and Compose examples;
- the structured output contract;
- safety, evidence, omission, and error rules.

The authoring contract is guidance for the agent, not an executable schema.
`PreviewRecipeLoader.parsePreviewRecipe` remains the only semantic recipe
parser and final authority. Every bundled example is tested against it so
support material cannot silently drift away from accepted syntax.

Framework compatibility facts are versioned separately from the recipe
schema. The first profile covers direct Next.js 15-16 development scripts. It
proves standard HTTP `PORT` delivery and classifies fixed `-p`/`--port`,
experimental HTTPS, and incompatible hostname arguments. When those conflicts
can be removed without changing the application entry point, the evidence
bundle supplies one exact Preview-only command and exact explanatory YAML
comment lines. Unknown script shapes, unsupported framework versions, and
unrecognized arguments remain fail-closed rather than becoming guessed
commands.

The Next.js profile also requires a safely validated root npm
`package-lock.json`. It supplies one exact generic
`npm ci --no-audit --no-fund` job, a repository-local framework command, and
the required `needs: succeeded` edge. `npm ci` may run repository and
dependency lifecycle scripts; that authority is stated in an exact review
comment and is not expanded into guessed script jobs. Missing, stale, unsafe,
ambiguous, or unsupported lockfiles/package managers produce a limitation
instead of an executable command. Generated recipes may not use `npm exec`,
`npx`, or package-manager `dlx` as implicit package acquisition.

The agent must return a single structured object containing either a complete
YAML draft or `insufficient-evidence`, plus:

- summary;
- evidence paths and specific findings;
- assumptions;
- omissions;
- unresolved decisions;
- exactly one structured decision for every detected browser-facing public
  environment candidate: HTTP attachment, intentional source default, or
  intentional omission.

Task Monki derives those candidates in trusted code. It lexes bounded
production JavaScript/TypeScript evidence for direct `process.env` access and
may inspect only explicitly named, Git-tracked templates such as
`.env.example` or `example.env`. It never reads actual or ignored `.env` files.
Template contents never leave the trusted parser; the agent sees only the
tracked relative evidence path, key metadata, and a URL target after strict
credential-free validation.
Conflicting or absent target evidence deterministically requires
`target: local`; generated output cannot override that policy with a guessed
literal endpoint.

Every evidence path must exist in the sanitized bundle. Outputs are bounded,
unknown fields are rejected, secret canary patterns are rejected, and a draft
without evidence is invalid.

Generated drafts may not retain a repository script with a known port or
protocol conflict. If a draft uses a supplied compatible framework command,
validation also requires its review comment. This keeps the compatibility
decision visible and prevents a model from silently reintroducing the original
fixed-port or HTTPS listener.

## Repository inspection boundary

The agent does not receive the live worktree as its working directory. Task
Monki creates a bounded temporary JSON evidence bundle containing safe text
from the task worktree and runs the ephemeral Codex process against that
temporary directory with:

- approval mode `never`;
- read-only sandboxing;
- the compatible Codex executable already selected by App Server runtime
  resolution;
- web search, MCP servers, and apps disabled with fail-closed discovery;
- sanitized process environment;
- a two-minute deadline and bounded output;
- explicit instructions not to run applications, tests, scripts, Docker,
  network services, or repository commands.

Traversal does not follow symlinks. It excludes likely secret-bearing paths
and contents, VCS/dependency/cache/generated directories, binary or invalid
UTF-8 files, unsupported formats, oversized files, and content beyond fixed
file/count/byte limits. A trusted bounded parser may reduce a root npm lockfile
to fixed fields such as lockfile version, root Next.js spec, and locked Next.js
version; raw lockfile contents, resolved URLs, and unrelated dependency data
are never included in the agent bundle. The report receives safe omission
counts, never excluded values. The temporary bundle is removed after success,
failure, cancellation, or shutdown.

This boundary minimizes exposure but does not claim that arbitrary ordinary
source files can never contain a secret. Repositories must still avoid
committing secrets. Generated YAML is additionally rejected when a
secret-like environment key has a literal value; it must use a declared
private input and typed recipient instead.

## Transient state and lifecycle

Generation snapshots and drafts are main-process memory only. They are not
stored in `FileTaskStore`, task snapshots, artifacts, logs, approval records,
or general provider history. Purpose-specific IPC sends only the current safe
snapshot and reviewed YAML.

One generation may run per task. Regeneration preserves the last valid draft
until a replacement succeeds. Task deletion cancels and joins generation
before worktree removal. Application shutdown cancels and joins every active
agent process and removes transient drafts. No generation timer, process,
listener, or evidence bundle survives shutdown.

## Validation and write boundary

Generated and user-edited YAML follows the same acceptance checks:

1. nonempty and at most 64 KiB;
2. accepted by `parsePreviewRecipe`;
3. no literal value for a secret-like environment key;
4. no implicit package-acquisition command;
5. every trusted framework command has its exact generic lockfile install job,
   lifecycle review comment, package-root cwd, and explicit success edge;
6. every public-environment decision has one exact active recipe recipient and
   obeys the derived literal-versus-local target policy;
7. draft ID still matches the current task draft and its transient capability
   facts, including after user edits;
8. task worktree and `.taskmonki` directory still resolve safely;
9. target file does not already exist.

Validation returns fixed safe issue messages rather than reflecting YAML
source snippets through errors. Agent stderr and raw malformed output are not
returned to the renderer or persisted.

Acceptance creates no plan approval and starts no runtime. If post-write plan
resolution cannot complete (for example, a required local engine is
unavailable), the UI reports that the recipe was saved and leaves **Check
preview** as the normal retry path.
