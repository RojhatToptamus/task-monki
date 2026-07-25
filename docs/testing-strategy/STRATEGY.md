# Agent testing strategy

Task Monki uses a layered workflow. No single layer is presented as proof of
the whole product.

## Chosen approach

The common post-change command is:

```sh
npm run test:agent-workflow
```

It compiles developer tooling and runs a synchronous, isolated scenario set
through the real `TaskManagerService`, production Git/worktree logic, agent
orchestrator, `AcpRuntimeAdapter`, ACP stdio supervisor, durable store, event
projection, and post-run Git evidence.

The provider boundary is a local deterministic Node child that speaks ACP v1.
It is deliberately not a fake store adapter and deliberately not evidence that
Grok, Claude, Cursor, Codex, OpenCode, or another live provider works.

The runner creates and owns:

- one private temporary root;
- one local bare Git remote;
- one source repository with a known initial commit and local upstream;
- ephemeral settings, task, agent-runtime, and discourse stores plus a
  worktree root;
- one deterministic ACP child and its protocol journal; and
- in UI mode only, one loopback API listener, one short-lived token lease, and
  one Vite child.

It removes or joins each owned resource. It never accepts a repository path,
user store, remote URL, provider credential, or GitHub destination.

## Responsibilities by layer

| Layer | Proves | Does not prove |
| --- | --- | --- |
| Focused Vitest | Pure rules, storage, protocol mapping, failure edges, process helpers | Whole application composition |
| Renderer JSDOM | Component behavior, selectors, accessible labels, renderer models | Real browser layout or backend lifecycle |
| Deterministic agent workflow | Service composition, real Git/worktrees, ACP child/process supervision, streaming activity, terminal outcomes, projection, independent Git evidence, cleanup | A live provider account/model or Electron main/preload behavior |
| Seeded development UI | Broad stable visual states, responsive layout, themes, empty/loading/error variants | Provider execution |
| Structured browser interaction | Real renderer interaction, accessibility-facing locators, visible state, screenshots | Electron-only IPC/native behavior unless Electron is launched |
| Packaged/Electron checks | Packaging, startup, preload/IPC/runtime files | Every agent workflow |
| Opt-in provider smoke | Installed runtime, real account/model, live protocol, attestation, real worktree mutation | Deterministic CI or automatic cleanup |

## Scenarios implemented now

The deterministic command runs three tasks against separate production
worktrees while one application-scoped ACP child is supervised:

1. **Complete:** streams a plan, file-change activity, and assistant output;
   writes a known file in the task worktree; completes; and requires Task
   Monki's Git evidence to observe the untracked file while the source
   repository remains clean.
2. **Fail:** streams diagnostic activity and returns an ACP token-limit
   terminal reason; Task Monki must record a failed run and useful final
   diagnostic without claiming a Git change.
3. **Cancel:** starts and streams activity but withholds its terminal response
   until Task Monki sends `session/cancel`; the run must become interrupted.

The report also requires protocol methods (`initialize`, `session/new`,
`session/prompt`, and `session/cancel`), a real recorded provider PID, plan and
item records, workflow projections, and post-run evidence. These assertions
would fail if the runner were changed back to direct store mutation.

## Everyday usage

### Domain, Git, worktree, workflow, or runtime changes

Run:

```sh
npm run test:agent-workflow
```

Read the final JSON report. A successful run exits zero only after cleanup.
The useful fields are:

- each scenario's run status and workflow phase;
- structured item types and plan steps;
- independent Git counts and observed path;
- provider protocol methods plus stable server and process ownership;
- deliberate-failure diagnostic;
- source-repository integrity; and
- setup, execution, and cleanup timings.

Unexpected failures still clean the exact owned root. Before cleanup, the
runner collects the current snapshot, protocol method tail, provider log tail,
and error into the report printed to stderr so diagnosis does not depend on
leftover directories.

### Visible renderer behavior

Run:

```sh
npm run test:agent-workflow -- --ui
```

The command first executes the same deterministic scenarios, then starts the
existing development HTTP server and Vite renderer over that exact store. It
prints the loopback renderer URL and keeps ownership until `Ctrl-C`.

Use a structured browser driver and semantic locators:

1. open the printed URL;
2. use a task's exact accessible name, such as
   `Open [agent-test:complete] Deterministic completion`;
3. inspect visible headings, statuses, actions, and output;
4. use the command's JSON report when exact structured state is needed;
5. capture a screenshot only when visual verification is relevant; and
6. send `Ctrl-C`, then require the command to report successful process joins
   and root removal.

Coordinate-based clicking is not an acceptable regression test. Loading,
failure, canceled, disabled, theme, focus, and responsive states should be
checked only when the change affects them. Seeds remain faster for visual
states that do not need an executed provider lifecycle.

### Real runtime integration

Only when a change affects a provider adapter or live protocol, use the
separately named existing smoke command:

```sh
npm run smoke:providers -- \
  --repository /absolute/path/to/an-explicit-throwaway-repository \
  --confirm-throwaway \
  --confirm-provider-usage
```

Follow `docs/PROVIDER_SMOKE_TESTING.md`. This can use an account, network, and
paid provider. Its retained report and state are intentional. A deterministic
agent-workflow pass must never be reported as a live-provider pass.

## Safety and cleanup contract

The default workflow:

- creates every path beneath a fresh operating-system temp directory;
- checks that cleanup targets are inside that exact root;
- uses only a filesystem path as the Git remote;
- passes only an allowlisted noncredential environment to the ACP and Vite
  children;
- shares the parent OS temp directory with Vite only for the existing private
  token rendezvous, which is consumed into proxy memory and removed;
- uses no user task store, GitHub repository, arbitrary database, or network;
- never pushes beyond the local bare remote created during setup;
- awaits Task Manager shutdown, which shuts down and joins the ACP child;
- terminates and joins the Vite process tree in UI mode;
- closes API event streams and listeners;
- disposes the token lease;
- removes the exact temporary root; and
- confirms that the root is absent before reporting success.

The runner does not accept `--root`, `--repository`, remote, executable, or
credential overrides. Tests that need those controls belong in focused test
helpers or the explicit provider-smoke workflow.

ACP cannot attest a network-disabled provider process, so Task Monki's
production ACP policy requires the task capability field to remain enabled.
That field is not treated as isolation evidence. The fixed deterministic child
receives no endpoint or credential variables and installs a guard that rejects
Node network modules, `fetch`, WebSocket, and EventSource before processing ACP
input. Changing the child to execute untrusted code or accept an executable
override would invalidate this safety boundary and requires a different
sandboxed test runtime.

## Why the alternatives were not selected

- **No MCP server:** a synchronous command and the existing HTTP API already
  provide structured control. MCP would duplicate lifecycle, schema, and
  security work without new coverage.
- **No new mutation API:** the runner calls `TaskManagerService` and the UI
  reuses the existing HTTP routes, so there is no test-only source of truth.
- **No seed expansion:** seeds remain the broad projected-state catalog; making
  them supervise providers would slow and blur their role.
- **No Playwright/WebdriverIO dependency now:** the common product risk is
  orchestration/Git/process behavior, which is faster below the UI. Coding
  agents can use their structured browser driver against `--ui`. Add a small
  checked-in browser suite only after repeated renderer interaction
  regressions justify its browser/runtime maintenance.
- **No default Electron launch:** Electron is needed for preload, IPC, native
  dialogs, focus across native windows, packaging, and OS integration. It is
  unnecessary for most workflow changes and would make the common loop slower.
- **No recorded ACP session as the main substitute:** a live local child
  preserves process ownership, stdio timing, cancellation, and shutdown. Small
  recorded messages remain useful in mapper tests.
- **No generic scenario DSL:** the three scenarios are direct, readable code.
  A DSL would be another orchestration layer with one consumer.

## Success measures

The workflow is successful when:

- a coding agent can run meaningful service/Git/provider-lifecycle coverage
  with one command in minutes;
- the command emits machine-readable state without UI rediscovery;
- the source repository is proven unchanged;
- expected failure and cancellation paths produce actionable state;
- a semantic browser interaction can be added without rebuilding the
  environment manually;
- no owned process, port, worktree, runtime, token, or test directory remains;
  and
- live provider claims remain gated by the separate opt-in smoke.

## Measured result

Implementation proof measurements are recorded here after running the final
workflow on the audit machine:

- Existing full seed setup: **49.76 s**.
- Deterministic workflow setup: **0.293 s**.
- Three-scenario execution: **2.863 s**.
- Cleanup: **0.066 s**.
- Deterministic runner total: **3.223 s**.
- Full documented npm command, including tools compilation: **6.51 s** wall
  time.
- UI-mode runner setup plus scenarios plus renderer startup: **3.323 s**
  after compilation (**0.271 s** setup, **2.856 s** execution, **0.196 s**
  UI startup).
- UI-mode cleanup after `Ctrl-C`: **0.109 s**.
- Opt-in authenticated Codex smoke, one explicitly selected model:
  **31.91 s** wall time including tools compilation and live execution.

The browser proof opened the completion, failed, and canceled task cards with
semantic role/name locators. It observed the completed dirty-file summary, the
failed token-limit reason, and the interrupted cancellation state, captured a
1280×720 screenshot, and found no renderer console warnings or errors. The
operator's inspection time is intentionally excluded from startup and cleanup
measurements.

An intentionally sandbox-blocked UI start also proved the unexpected-failure
path: the command emitted the task/run/event/provider diagnostic bundle, then
reported the service stopped, root removed, provider joined, and no cleanup
errors.

The opt-in smoke ran `codex:gpt-5.4-mini` at low reasoning and passed with
provider-confirmed model selection, a completed run, independently verified
sentinel output, and unchanged source-repository HEAD/ref. This is live
provider evidence for that one audited model, not for the deterministic
runtime or the rest of the catalog. The smoke's retained audit directories
were inspected and then explicitly removed for this investigation.

These numbers are observations from the audit machine, not performance
budgets.

## Deliberately deferred

- A checked-in Playwright browser or Electron suite.
- An MCP/product automation interface.
- Automatic creation/cleanup changes to paid-provider smoke.
- GitHub remote simulation; the selected scenarios need upstream Git state but
  not GitHub semantics.
- Preview lifecycle scenarios. Preview has dedicated tests and seeded states;
  add a runner scenario only for a concrete cross-boundary regression.
- Review/follow-up scenarios. Existing service tests cover the detailed review
  lifecycle. Add one here when a regression specifically needs provider stdio,
  Git evidence, and review projection in the same proof.

Manual visual judgment remains necessary for typography, spacing, animation,
platform-native focus/dialog behavior, and subjective design quality. It
should be performed against the relevant seed or `--ui` environment, not
inferred from a deterministic JSON report.
