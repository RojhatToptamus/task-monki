# Installing Task Monki

Date: 2026-07-14

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
  - Antigravity CLI (`agy`); or
  - an ACP profile: Grok Build, Cursor Agent, or `claude-agent-acp`;
- Optional: GitHub CLI, installed and authenticated, for branch publishing and
  draft pull-request features

Task Monki does not bundle Git, agent runtimes, or GitHub CLI. Packaged desktop
apps probe each registered runtime independently. One unavailable runtime does
not prevent another from working. Authentication and upstream model-provider
configuration remain owned by the selected runtime.

Settings provides custom executable paths for Git, GitHub CLI, Codex CLI,
OpenCode, Antigravity, and every registered ACP runtime. Use Auto-detect to
return a saved path to environment-override and then PATH-based discovery.

Environment variables are supported as debug overrides and take precedence over
saved Settings values:

```sh
TASK_MANAGER_GIT_PATH=/path/to/git
TASK_MONKI_CODEX_BIN=/path/to/codex
TASK_MONKI_OPENCODE_BIN=/path/to/opencode
TASK_MONKI_ANTIGRAVITY_BIN=/path/to/agy
TASK_MONKI_GROK_ACP_BIN=/path/to/grok
TASK_MONKI_CURSOR_AGENT_ACP_BIN=/path/to/cursor-agent
TASK_MONKI_CLAUDE_AGENT_ACP_BIN=/path/to/claude-agent-acp
TASK_MANAGER_GH_PATH=/path/to/gh
```

Git and one ready agent runtime are required to run a task. GitHub CLI is
optional; GitHub delivery features report it as unavailable when `gh` cannot
be resolved.

Codex and OpenCode are native server integrations. Antigravity is a dedicated
turn-scoped integration over its documented CLI print contract. ACP profiles
remain distinct integrations, not interchangeable model-provider shims. The
browser development server only enables runtimes that attest its stronger
isolation boundary; use the packaged Electron app for Antigravity, OpenCode,
and current ACP profiles.

## Provider setup and readiness

Runtime discovery is intentionally staged. Finding an executable does not prove
that it is the correct agent, that its protocol is compatible, or that the
current provider account can create a session. Settings and the New Task flow
show these states separately:

| Status | Meaning | Next step |
| --- | --- | --- |
| Not installed | No candidate executable could be launched. | Install the runtime or choose its executable in Settings. |
| Incompatible | An executable ran, but its required App Server, HTTP server, or provider-specific ACP launch contract was not proved. | Inspect the selected path and discovery diagnostics; choose the correct executable. |
| Available to start | Non-mutating discovery succeeded. Live provider authentication, account access, and models have not yet been verified. | Start or attach a provider session. |
| Sign in required | The runtime started, but the provider rejected session creation for missing authentication. | Sign in using that provider's own CLI, then refresh or retry. |
| Account unsupported | The runtime is authenticated, but that account or client path cannot create the required session. | Choose a supported account path or another runtime. |
| Ready | The runtime completed its required live validation. On-demand ACP runtimes reach this state after a provider session is created or resumed. | Create or continue the task. |
| Security policy unsupported | The runtime cannot attest the filesystem, process, or network boundary required by the current surface or operation. | Choose a compatible runtime or use the packaged desktop surface when appropriate. |
| Degraded / Unavailable | A later health, protocol, configuration, or initialization check failed. | Open runtime details and follow the reported action. |

Provider-owned authentication should be completed with the provider's own CLI;
Task Monki neither collects credentials nor runs login flows. Runtime details
show bounded, redacted diagnostics, the selected executable, its native launch
form, and rejected candidates. For ACP runtimes, every candidate—including a
custom path—must pass both a version command and a non-mutating, profile-owned
launch-contract probe. A successful `--version` alone is not accepted as ACP
support.

Following Google's
[Gemini CLI transition announcement](https://github.com/google-gemini/gemini-cli/discussions/27274),
Antigravity replaces the former Gemini ACP product registration. It is not
presented as ACP: Task Monki uses only public `agy models` and one documented
`agy --print` process per turn. Every turn includes `--new-project` because cwd
alone does not reliably bind Antigravity to the requested repository, plus
`--sandbox` and a bounded `--print-timeout`. Implementation, follow-up, and
retry turns use `--mode accept-edits`; analysis uses `--mode plan`. Task Monki
never passes `--dangerously-skip-permissions`.

The public Antigravity print command has no documented stdin or prompt-file
input, so the full task prompt is present in the live `agy` process argument
list and may be visible to same-user process inspection or endpoint telemetry.
Task Monki stores a `<prompt>` placeholder instead of the prompt in durable
command records. Do not put passwords, tokens, private keys, or other secrets
in Antigravity task prompts.

The exact lines from `agy models` are the selectable model values and are sent
back unchanged through `--model`. The CLI does not mark a default, so Task
Monki does not mark one either. New Task may initially select the first label in
provider order, but execution requires and records that exact selection rather
than applying a hidden adapter fallback. This integration has no provider
session ID, resume/fork, structured
tool events, Task Monki approval requests, managed attachments, prompt
refinement, or detached review. Terminal-command permissions remain
Antigravity-owned and may not be answerable in non-interactive print mode.

After an ACP session is attached, the task's Provider inspector shows only the
schema-selected native model, mode, and configuration controls advertised by
that session. Model catalogs remain provider-specific; changing a session model
uses that agent's native model operation rather than translating it into a
generic model name. Controls are available only while the session is idle and
are disabled for active or recovery-required work.

Current ACP profiles require the provider-controlled full-access preset with
network access and user-reviewed, on-request approvals. ACP does not attest a
Task Monki filesystem or network sandbox, so restricted presets fail closed
instead of being silently weakened.

OpenCode likewise has no attested process sandbox. Its two presets both report
full process access: Ask for approval gates native mutation and external-
directory tools, while Full access uses `approvalPolicy: never`. Provider,
plugin, MCP, and process-level network activity remains provider-controlled in
both modes.

Antigravity uses a separate sandboxed-project preset. `--new-project` binds the
turn to the canonical Task Monki worktree, `--sandbox` enables documented
terminal restrictions, and `--mode accept-edits` permits implementation edits.
The CLI still owns terminal permission decisions; Task Monki does not claim a
structured approval bridge.

## Provider environment contracts

Agent children do not inherit arbitrary host variables. They start with Task
Monki's minimal process environment plus a versioned, exact provider contract:

| Runtime | Explicitly supported environment configuration |
| --- | --- |
| Codex | `CODEX_HOME` only, through the Codex-owned environment contract; it is not exposed to other runtimes |
| OpenCode | `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, inline OpenCode config, OpenAI/Azure OpenAI, Anthropic, xAI, Gemini/Google, AWS Bedrock, Google Vertex, and enterprise proxy/CA keys |
| Antigravity | User config/data/state/cache roots plus enterprise proxy/CA keys; on macOS Task Monki supplies the fixed non-secret `XPC_SERVICE_NAME=application.com.google.antigravity`, while provider authentication remains in Antigravity's own configuration |
| Grok Build ACP | xAI/Grok API keys and endpoint plus enterprise proxy/CA keys |
| Cursor Agent ACP | Cursor API key plus enterprise proxy/CA keys |
| Claude Agent ACP | Anthropic API/OAuth and endpoint settings, Claude config directory, Bedrock AWS credentials/profile/web-identity/container auth, Vertex Google credentials/project/region, and enterprise proxy/CA keys |

The allowlists use exact names—never provider-looking prefixes—so unrelated
application secrets remain unavailable to runtime children. File-path and
inline-config values that may lead to credentials are treated as sensitive in
diagnostics. OpenCode custom providers that need another environment variable
must store authentication through OpenCode's own auth/config mechanisms rather
than relying on Task Monki to forward the entire host environment.

The contracts follow the providers' documented configuration surfaces:
[OpenCode CLI](https://opencode.ai/docs/cli/) and
[config](https://opencode.ai/docs/config/),
[Antigravity CLI reference](https://antigravity.google/docs/cli-reference),
[execution modes](https://antigravity.google/docs/cli/modes),
[conversation lifecycle](https://antigravity.google/docs/cli-conversations),
[Claude gateway/cloud settings](https://docs.anthropic.com/en/docs/claude-code/llm-gateway),
and the [AWS SDK environment reference](https://docs.aws.amazon.com/sdkref/latest/guide/settings-reference.html).

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
