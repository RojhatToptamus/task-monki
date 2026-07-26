# Agent testing workflow research

This document records the evidence used to choose a post-change testing
workflow for coding agents working on Task Monki. It distinguishes verified
repository facts from conclusions and open questions. It is not a general test
tool survey.

## Scope and method

The audit was performed against `v0.2.0-alpha.1` (`02ee4e87`) on 25 July
2026. The worktree was clean and detached before the investigation began.

The repository instructions and the required product, runtime, preview,
workflow, protocol, seeding, provider-smoke, and design documents were read
before implementation. The audit also covered test configuration, CI,
renderer tests, Electron and browser-development boundaries, the task service,
agent orchestration, ACP and Codex adapters, worktree creation, preview
lifecycle, test support, provider smoke tests, and Git history.

## Verified current state

### Test layers that already work

- Vitest is the fast default. Node tests cover core, storage, Git, process
  supervision, runtime adapters, protocol mapping, workflow projection,
  transport, and most renderer model logic. JSDOM renderer tests run through a
  separate configuration.
- CI runs architecture and protocol checks, type checking, Node and renderer
  tests, the build, package verification, and packaged-runtime smoke checks on
  macOS, Linux, and Windows.
- `src/testSupport/taskMonkiScenario.ts` creates a real temporary Git
  repository, `FileTaskStore`, `TaskManagerService`, and worktree root. Many
  service tests use it successfully.
- That helper injects `ScriptedAgentRuntimeAdapter`. The adapter writes
  provider-like state directly to `FileTaskStore`; it does not launch a
  provider subprocess, negotiate a protocol, stream stdio, or prove process
  shutdown.
- ACP adapter tests already contain the important lower-level mechanism that
  the missing workflow needs: a Node child implementing ACP over stdio, driven
  through the production `AcpRuntimeAdapter` and `AcpStdioSupervisor`.
- The development HTTP server exposes the renderer's typed
  `TaskManagerService` operations. `GET /api/board` returns compact board and
  Inbox truth, while `GET /api/tasks/:taskId` returns fresh selected-task
  detail; mutations such as task creation, worktree preparation, run
  start/cancel/retry/continue, review, and evidence refresh use the same
  service methods as the app.
- The HTTP surface is loopback-only, token-protected, host/origin/fetch-site
  checked, and intentionally prevents browser-development agent turns from
  escaping its network boundary.
- Renderer DOM tests are appropriate for component behavior and selectors, but
  they do not start Electron, Git, a provider process, or a real worktree.

### Seeds

- `npm run dev:seed` builds 87 stable scenarios for renderer and workflow
  inspection. Scenario slugs make visual states easy to find.
- The generated data exercises real store APIs while being created, but the
  resulting application is projected state. It deliberately disables provider
  startup in browser development.
- A semantic browser interaction against
  `[seed:delivery-checks-failed]` successfully opened the task and displayed
  the expected failed PR checks. This proves the seed is valuable for visual
  state inspection, not provider lifecycle.
- From an installed workspace, a full `npm run dev:seed` took **49.76 s**
  (`19.60 s` user, `15.43 s` system) on the audit machine. Before dependencies
  were installed it failed immediately because `tsc` was unavailable.
- Starting the seeded API and renderer required two long-lived commands. A
  sandboxed loopback bind failed until explicitly allowed. One API start
  attempted preview reconciliation and shutdown later reported four preview
  generations with unverified cleanup residue. The renderer also emitted a
  proxy error when the API stopped first.

These observations are evidence that seeds should stay focused on broad,
stable UI states rather than becoming the common agent execution harness.

### Provider smoke testing

- `npm run smoke:providers` is explicitly opt-in. It requires both
  `--confirm-throwaway` and `--confirm-provider-usage`, a clean caller-created
  repository with a commit and no remotes, and a real installed provider.
- It uses the real `TaskManagerService`, model discovery, runtime adapter,
  sentinel output, worktree Git inspection, and model-selection attestation.
  It rejects unresolved interactions and checks that the source repository was
  unchanged.
- It intentionally retains its state root, worktrees, branches, protocol
  evidence, and report for diagnosis. It does not create the throwaway
  repository or clean it up.
- Its tests cover prerequisites, timeout/cancel behavior, provider claims
  versus Git evidence, model attestation, and report authority.

This is the correct real-provider boundary, but its cost, credentials, network
dependency, and retained state make it unsuitable as the default post-change
loop.

During implementation verification, the installed authenticated Codex runtime
was first cataloged without executing a model, then one explicitly selected
model (`codex:gpt-5.4-mini`) passed the existing smoke in **31.91 s** wall time.
The authoritative report recorded provider-confirmed selection, a completed
run, verified sentinel output in the worktree, and an unchanged clean source
repository. That is deliberately separate from deterministic runtime proof.

The proof cleanup removed its throwaway live repository, smoke state, and Codex
rollout. Codex `0.144.6` then returned a state-database cleanup error because the
local database lacks its expected `agent_jobs` table. Exact-CWD thread listing
returns no session, but Codex still logs that it dropped a stale database row
from the result. The user-owned Codex database was deliberately not edited
directly; that stale metadata row is an external CLI cleanup defect, not Task
Monki test evidence.

### Git and worktree behavior

- `TaskManagerService.prepareWorktree()` calls the production
  `WorktreeService`, records the iteration/worktree first, creates the real Git
  worktree, verifies it, and refreshes Git evidence.
- Post-run evidence is independently observed after terminal provider events.
  Provider output is telemetry; it does not establish that a file changed.
- Existing test helpers create local repositories, but there was no reusable
  developer command that also creates a local bare remote, executes a provider
  subprocess, reports structured workflow state, and owns cleanup.

### History

Git history did not contain a removed, proven Task Monki agent-testing driver
to restore.

- The initial browser-development work ignored `.playwright-mcp/` but did not
  contain a Playwright dependency or application E2E suite.
- A removed showcase capture script used headless Chromium and careful
  screenshot/process cleanup. It was coupled to legacy showcase data and
  Remotion, not to current Task Monki workflow execution.
- An unmerged historical provider lifecycle smoke covered paid-provider
  cancel/retry/continue cases. It never became the product baseline.
- The current scripted scenario helper predates the latest refactors; it has
  never exercised provider process supervision.

## External implementations and transferable lessons

The sources below are current primary documentation or source code. The useful
pattern is consistent: keep a fast deterministic boundary, run real processes
where process behavior is the subject, isolate filesystem/user state, use
semantic UI control sparingly, and separate live external-service checks.

### Electron, Playwright, and WebdriverIO

- Electron's [automated testing guide](https://www.electronjs.org/docs/latest/tutorial/automated-testing)
  presents WebdriverIO and Playwright rather than prescribing an Electron-owned
  framework.
- Playwright's Electron API is explicitly
  [experimental](https://playwright.dev/docs/api/class-electron). It can launch
  an app, evaluate in the main process, obtain the first window, interact, and
  capture screenshots. Native dialogs still need main-process substitution.
- Playwright recommends
  [role, label, and other user-facing locators](https://playwright.dev/docs/locators)
  with auto-waiting instead of coordinate or DOM-structure selectors. Its
  [trace viewer](https://playwright.dev/docs/trace-viewer-intro) retains action,
  DOM, console, error, and network context for failures.
- WebdriverIO's
  [Electron service](https://webdriver.io/docs/wdio-electron-service/) adds
  Electron binary discovery, API mocking, main/renderer log capture, window
  tracking, and headless support, but requires a second substantial runner
  stack.

Transfer: use semantic browser interaction and screenshots when rendering,
focus, accessibility, or actual interaction is the requirement. Do not add a
second browser stack to validate domain workflows already exposed through the
service boundary.

### VS Code

- VS Code keeps unit tests in its fast contributor loop and has a separate
  [smoke suite](https://github.com/microsoft/vscode/blob/main/test/smoke/README.md)
  for Electron and web builds.
- The smoke guide calls out shared state, global ports/IPC handles, focus,
  timing, and arbitrary sleeps as specific flake risks. Tests wait for the DOM
  or active element instead of hoping that a UI transition finished.
- Release smoke uses separate user-data and extension directories and a known
  repository, as described in the
  [official smoke-test workflow](https://github.com/microsoft/vscode/wiki/Smoke-Test).

Transfer: Task Monki needs isolated state roots and semantic waits. A full
Electron smoke suite is valuable only for Electron-specific boundaries; it is
too costly for every agent-domain change.

### GitHub Desktop

- GitHub Desktop's current
  [Playwright Electron fixtures](https://github.com/desktop/desktop/blob/development/app/test/e2e/e2e-fixtures.ts)
  launch one app per worker, replace user/config directories, disable SSH,
  capture console/page errors, record traces/video, close the app, and join
  owned services.
- Its
  [test repository helper](https://github.com/desktop/desktop/blob/development/app/test/e2e/test-helpers.ts)
  deletes only a known temp path, initializes a repository, configures a test
  identity, commits known content, and independently queries Git status,
  branch, and commit message.

Transfer: exact temp ownership and independent Git assertions belong in Task
Monki's runner. Launching Electron is not necessary to prove service,
worktree, provider, and projection behavior.

### Codex

- Codex app-server integration tests launch a real child and communicate over
  its production stdio protocol through
  [`TestAppServer`](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/common/test_app_server.rs).
  The harness owns a temporary `CODEX_HOME`, time-bounded reads, structured
  JSON logs, and graceful shutdown.
- The same suite substitutes the paid model boundary with a local ordered SSE
  server in
  [`mock_model_server.rs`](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/common/mock_model_server.rs),
  including exact expected call counts.

Transfer: the deterministic substitute should sit behind the real subprocess
and protocol boundary. It must not be described as proof of OpenAI or another
provider service.

### Cline

- Cline's
  [headless tests](https://github.com/cline/cline/blob/main/apps/cli/src/tests/headless/headless.test.ts)
  execute the CLI as a child and assert visible output and exit status.
  JSON/headless fixtures provide repeatability, while provider-dependent cases
  are tagged `@live`.
- Its
  [live persisted-message contract](https://github.com/cline/cline/blob/main/apps/cli/src/tests/headless/messages-contract.live.test.ts)
  uses a fresh temporary session-data directory and checks structured
  artifacts independently of terminal text.

Transfer: one structured command is cheaper for coding agents than repeatedly
rediscovering the UI, while separately named live checks preserve honesty.

### Zed

- Zed has fake-filesystem worktree coverage in
  [`fake_git_repo_tests.rs`](https://github.com/zed-industries/zed/blob/main/crates/fs/tests/integration/fake_git_repo_tests.rs)
  and shared agent-server E2E behavior in
  [`e2e_tests.rs`](https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/e2e_tests.rs),
  including message, tool, permission, and cancellation behavior.

Transfer: reusable behavioral contracts are useful, but Task Monki must also
run real local Git because Git observation is one of its authoritative product
boundaries.

## Candidate comparison

Scores are relative to Task Monki's common post-change loop: high is favorable
for speed, coverage, and diagnostics; low is favorable only in the
maintenance-cost column.

| Candidate | Speed | Real service/Git/process coverage | UI | Live provider | Diagnostic quality | Maintenance cost | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Extend seeds | Low setup; fast once running | Low | High for projected states | None | Medium | Medium/high if distorted | Preserve, do not extend into execution |
| Developer CLI/scenario command | High | High | Opens a URL when needed | Can delegate to existing smoke | High structured output | Low/medium | Selected |
| MCP server | Medium | Same as backing API | None by itself | Same as backing API | High | High: service lifecycle and schema | Reject now |
| Existing HTTP API alone | Medium/manual startup | High once composed correctly | High | Possible but unsafe in browser dev | High | Low | Reuse under the command for UI |
| New test-only driver API | High | Risks divergent behavior | Optional | None | High | High | Reject |
| Playwright browser build | Medium | Service path only if backend is real | High | None | High with traces | Medium plus browser install | Defer as a small UI suite |
| Playwright/WDIO Electron | Low for inner loop | Highest Electron coverage | Highest | None | High | High | Defer to Electron-specific needs |
| Renderer DOM tests | Highest | None outside renderer | Medium | None | High | Existing | Keep |
| In-process fake adapter | Highest | Misses protocol/process boundary | None | None | Medium | Existing | Keep for focused service tests |
| Recorded provider messages | High | Mapper/replay only; timing can drift | None | None | Medium | Fixture drift | Use only for protocol regressions |
| Local deterministic ACP subprocess | High | High through current production adapter | None | Explicitly not live | High journals/state | Low because ACP support exists | Selected |
| Opt-in provider smoke | Low/costly | Highest provider coverage | None | Yes | High, retained report | Existing | Keep separate |
| Temp repo + local bare remote factory | High | Real local Git and upstream state | None | None | High | Low | Selected inside runner |

### Why MCP is not selected

The current problem is repeatable verification, not an ongoing multi-client
conversation with Task Monki. MCP would need process startup, tool schemas,
state and cleanup semantics, authentication, and another compatibility
surface. Its tools would ultimately call the same `TaskManagerService` methods
already reachable from a synchronous Node command and the development HTTP
API. It adds no present coverage.

MCP should be reconsidered only if coding agents need to attach to and control
an already-running user-owned Task Monki instance across many independent
interactive turns. That would be a product capability with a new security
boundary, not a test helper.

## Conclusion

The smallest useful addition is a developer scenario command that:

1. owns a temporary root, real repository, local bare remote, store, and
   worktree root;
2. injects the production `AcpRuntimeAdapter` connected to a deterministic
   local ACP child;
3. runs representative complete, failed, and canceled workflows through
   `TaskManagerService`;
4. inspects authoritative snapshots, Git evidence, provider journals, and
   runtime activity;
5. prints a structured report and joins/removes everything it owns; and
6. optionally serves that exact completed environment through the existing
   authenticated development HTTP/Vite path for semantic browser interaction.

This fills the missing middle layer without changing product behavior. Seeds,
Vitest/JSDOM, browser interaction, Electron-specific testing, and real-provider
smoke each retain a clear boundary.

## Assumptions and open questions

- **Verified after implementation:** the deterministic workflow, UI
  interaction, failure diagnostic, timings, and exact cleanup proof are
  recorded in `STRATEGY.md`.
- **Assumption:** three representative outcomes are enough to establish the
  common pattern. More scenarios should be added only when a real regression
  cannot be expressed by existing focused tests plus these outcomes.
- **Deferred question:** whether repeated Electron-only regressions justify a
  very small Playwright Electron suite. No current failure evidence justifies
  that dependency and startup cost.
- **Deferred question:** whether provider-smoke should eventually create and
  remove its own throwaway repository. Its intentional evidence retention and
  explicit paid-provider safety contract require a separate design decision.
