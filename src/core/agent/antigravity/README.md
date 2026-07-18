# Antigravity runtime

This directory implements Task Monki's dedicated Google Antigravity CLI
runtime. It is a turn-scoped integration over the documented non-interactive
command surface, not Gemini ACP, a private Antigravity API, or a TUI/log parser.

## Public contract

Task Monki resolves an installed `agy` executable and requires `agy --help` to
advertise all of these public operations before accepting it:

- `agy models` for the current model catalog;
- `--print` and `--model` for a non-interactive turn;
- `--new-project` for a fresh provider project;
- `--sandbox` for the documented terminal sandbox;
- `--print-timeout` for a bounded provider turn; and
- `--mode` with `plan` or `accept-edits`.

Analysis uses `plan`. Implementation, follow-up, and retry use `accept-edits`.
Every turn includes `--new-project`, `--sandbox`, and `--print-timeout 30m`.
Task Monki never passes `--dangerously-skip-permissions`.

The documented print form accepts the prompt only as the value following
`--print`; it does not advertise stdin or prompt-file input. Task Monki must
therefore place the full prompt in the live child process argv, where same-user
process inspection or endpoint telemetry may observe it. Durable server argv
uses `<prompt>` and protocol records retain only the prompt artifact reference.
Do not put passwords, access tokens, private keys, or other secrets in an
Antigravity task prompt.

The model parser preserves each bounded, safe `agy models` line exactly and in
provider order. Known label prefixes are classified for UI grouping only:
Gemini as `google`, Claude as `anthropic`, GPT as `openai`, and unknown labels
as `antigravity`. Every entry has `isDefault: false`; execution requires an
exact advertised label and never applies an adapter-side first-model fallback.
Successful catalogs have a 60-second TTL. Concurrent reads share one bounded
`agy models` process. If an exact selected label is absent, execution forces one
coalesced refresh before rejecting it, so a newly enabled label need not wait
for the TTL or an application restart.

## Lifecycle and ownership

The runtime descriptor has `lifecycleScope: TURN`. Task Monki keeps a local
materialized session so runs retain durable task/iteration/worktree ownership,
but it never invents a provider session ID. The per-run provider-turn value is
only a local process correlation ID used for interruption.

One child process owns one turn. Its cwd is the canonical Task Monki worktree,
and session creation rejects a worktree that does not resolve to the same
directory. Canonical aliases such as macOS `/var` and `/private/var` are valid
only when both paths resolve to the same existing directory. `--new-project`
is still mandatory because Antigravity's conversation state is workspace-
scoped and cwd alone must not cause a prior provider project to be reused.

Task Monki intentionally does not use Antigravity's interactive conversation
resume, fork, or picker. Print mode provides no structured provider session
ownership or recovery contract for those features. Every managed turn starts
a new Antigravity project.

## Output, terminal state, and recovery

Assistant stdout is streamed to the run output artifact and retained as the
final message. Stderr is diagnostic telemetry. Each decoded stream keeps an
in-memory carryover until it has a complete line, then credential-redacts that
line before it can reach the protocol journal, artifact, final state, or UI.
Streaming is therefore line-granular rather than token-granular; a final
incomplete line is securely flushed when the process closes. A line over 64
KiB is discarded instead of partially persisted and replaced with a safe
`[Antigravity <stream> line discarded at the 64 KiB safety limit.]` marker.

After line safety and redaction, journal and artifact retention use the same
runtime-specific per-turn budgets: 1 MiB for stdout and 128 KiB for stderr.
The adapter stops journaling that stream at its budget and emits exactly one
fixed truncation marker beyond the retained content. Journal entries are also
split at 64 KiB so no individual provider-output record is unbounded.

A zero exit completes the run, a nonzero exit fails it, and an owned process
interruption marks it interrupted. Process output, close, interrupt, and
shutdown decisions share one per-turn queue. A natural close queued first
keeps its completed or failed outcome. An interrupt queued first durably marks
the run `INTERRUPTING`, records its cancellation reason, cancels the process,
and finalizes it `INTERRUPTED`; cleanup never adds a cancellation reason after
it has started. The adapter does not infer success from assistant prose. If
Task Monki loses process ownership, cannot persist terminal state, or restarts
during a live turn, it marks the outcome recovery-required and never
automatically replays the prompt. Startup persistence failure rejects the
caller promptly while ownership remains tracked until bounded cancellation and
recovery publication finish. A definite failure before process ownership
terminalizes the created server record as failed and rejects without creating
an active turn.

## Capability boundary

The public print stream does not expose structured tools, diffs, plans,
approvals, questions, usage, subagents, attachments, active steering, native
review, or user-input requests. Those capabilities are reported unsupported;
provider terminal permission handling remains Antigravity-owned. Task Monki
does not inspect hidden APIs, intercept authentication, scrape the TUI or logs,
or impersonate another runtime to manufacture parity.

The child receives only the portable process environment plus the exact
`task-monki/antigravity-environment@v3` user-config and proxy/CA contract. On
macOS, Task Monki sets the fixed non-secret
`XPC_SERVICE_NAME=application.com.google.antigravity`; it never trusts or
forwards an ambient XPC value, and it omits the macOS-only key on other
platforms. The official macOS CLI reports that sign-in is
required when a desktop-launched process strips that XPC service identity, even
though the same user is already authenticated; supplying that reviewed identity
lets `agy models` and print turns see the existing provider-owned sign-in.
Task Monki does not admit other XPC or arbitrary host variables. Authentication
remains in Antigravity's own configuration. Executable override variables are
resolver inputs and are not forwarded to the child.

Catalog command failures retain a bounded, credential-redacted stderr
diagnostic and a 45-second process bound. Task Monki closes the stdin pipe for
this complete non-interactive command; the official CLI otherwise waits for
EOF instead of returning its already-available catalog. The failure is
reported fail-closed on the current catalog read; a later catalog refresh
performs a new discovery attempt instead of latching the original result for
the life of the application. An expired refresh never falls back to the prior
catalog: its models are cleared and readiness reports the catalog failure.

## Settings and history migration

App-settings schema 6 replaces a default `gemini-acp` selection with
`antigravity` but clears the old model/provider/reasoning values and executable
path because the protocols are incompatible. Review and refinement selections
fall back to Codex because this runtime does not support those operations.
Historical tasks, sessions, runs, events, and artifacts keep `gemini-acp`; they
are immutable evidence and cannot be resumed as Antigravity.

References:

- [Antigravity CLI reference](https://antigravity.google/docs/cli-reference)
- [Execution modes](https://antigravity.google/docs/cli/modes)
- [Conversation lifecycle](https://antigravity.google/docs/cli-conversations)
- [Gemini CLI transition announcement](https://github.com/google-gemini/gemini-cli/discussions/27274)
