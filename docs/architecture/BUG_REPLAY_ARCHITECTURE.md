# Bug Replay Architecture

Date: 2026-10-17

Bug Replay turns a bug the person saw in the running app into a check Task Monki
runs itself. The person records the bug in a clean copy of the task's app and
marks what is wrong; Task Monki confirms the bug on the recorded code, hands it to
the task's agent, and verifies every agent turn against it on a fresh clean copy.

Read this before changing `src/core/bugReplay`, the recording host
(`src/electron/BugRecordingViewHost.ts`), the Bug Replay store, the bug brief in
prompts, or any surface that shows a bug.

## Authority

- **Task Monki owns the verdict.** A bug's state comes only from runs Task
  Monki executed with its own runner and evaluated with `BugReplayVerdict`. The
  agent's claims ("fixed and tested") are provider telemetry, never evidence.
- **The person owns the expectation.** Only saving a capture creates a case
  version. Agents, recipes and renderer requests cannot write one. The bug
  reference on a task instruction (`TaskInstruction.bugCase`) is set only by
  Bug Replay's hand-off; queue and continue requests from the renderer cannot
  carry it (`BugReplayInput` keeps only known fields).
- **Bug Replay is a detached gate.** Every `BUG_*` domain event carries the
  whole gate projection, and the reducer copies it to `projection.bugReplay`.
  It never moves the workflow phase, the current run, or the agent review gate.
  A recorded bug never blocks Mark done; an unverified one makes done an
  override.

## Pieces

| Piece | Owns |
|---|---|
| `BugRecordingService` | One recording session at a time: freezing the worktree, choosing ignored env files, approval, starting a `br-` environment, the native view, marking, saving. |
| `BugRecordingViewHost` (Electron, macOS) | The native `WebContentsView` the page is recorded in, its private session, request filter and CDP recorder. |
| `recorder/*` | The recorder injected into an isolated world: actions, requests, console, picks. |
| `BugCaseCompiler` | A sealed recording plus the person's checks → a strict `bug-case/v1` document and its failure signature. |
| `BugReplayService` | Cases, versions, runs, scheduling, qualification, verification, refills, hand-off tracking, pruning, startup recovery. |
| `ReplayDerivation`, `ReplayEnvironment`, `ReplaySourceFreezer` | The `br-` Previewhost spec derived from the task's recipe, its start and teardown, and frozen source exports. |
| `ReplayAuthorization` | The per-task approval to run clean copies, and Previewhost's per-start approval. |
| `BugReplayRunner`, `runner/*` | The runner process (Task Monki's Node, playwright-core, Chrome for Testing) and its framed output. |
| `BugReplayGate`, `BugReplayVerdict` | Pure rules: what a run means, and the bug's state from its runs. |
| `BugReplayContext` | Everything that leaves Task Monki about a bug: the agent brief, the reviewer section, the pull request block. |
| `BugReplayViews` | What the renderer reads: words, lines and actions already decided. |
| `SqliteBugReplayStore` | Durable records and evidence files. |

## Recording

Record bug is offered on the Preview tab of a normal task with a worktree and a
preview recipe, in the desktop app on macOS, while the task is open. It is shown
but disabled while the agent changes the task's files, while another task is
recording, or when evidence storage is full; the reason is stated beside it.

1. **Freeze.** The worktree, including uncommitted and untracked files, is
   captured as a Git tree and pinned under `refs/tasks/<task>/bug-replay/*`.
   Submodules, two recipe files, recipes Task Monki cannot run and untracked
   files it cannot copy (over 5 MB, over 256 MB in all, or not regular files)
   are refused with the reason and what makes them possible again.
2. **Env files.** Git-ignored `.env*` files in the directories the recipe runs
   code in are listed; each is proposed included, and the person chooses. Their
   contents stay on the machine and are copied only into the clean copy.
3. **Approval.** See "Approval to run". Nothing starts before it.
4. **Start.** The recipe is derived into a `br-<12 hex>` environment over the
   frozen export, on fresh data. The person's own preview keeps running.
5. **Record.** The page loads in the native view at a pinned 1280×800 viewport.
   The view's session is private to the recording, allows only the run's own
   origins (plus `about:blank` and same-view `data:`/`blob:` subresources),
   denies popups, downloads and permission prompts, and is cleared when the
   recording ends. A typed password is kept in the case so runs can type it
   again, masked on every surface and left out of the stored action log; the
   capture panel says so.
6. **Mark.** Mark bug seals the window since the last action and starts
   pointing. Pointing never blocks the person: Stop pointing, Escape, Back to
   recording and Discard stay available, and marking returns at once while the
   pick arrives in the background. Only the person's own input points: events
   the page dispatches are ignored, the recorder listens ahead of the page's
   document listeners, stopping never sends the page an event, and only the top
   frame's recorder world can point.
7. **Name.** One rule names an element on its pick, in its checks and in their
   evidence: its label or accessible name, its test id read as words
   ("noteCount" is "Note count"), the words beside it on its own line, or its
   placeholder, never text that repeats what a check reads. The suggested title
   states the observation ("Cart total shows "$40.00""), or names the page when
   nothing was picked; the person can change it.
8. **Save.** Save and reproduce needs at least one check the recording itself
   violated (the failure signature); otherwise the capture can only be saved
   without a check, as evidence. Saving pins the recorded tree, then commits the
   capture, the case, its approved version and the version's two qualification
   runs together, so a saved check is always reproduced. Saving replaces the
   task's current bug, which moves to Earlier bugs. A save that fails deletes
   the evidence it wrote and returns the person to the capture.

A recording ends as interrupted when the environment stops, the view crashes or
the 60 minute limit is reached, and as ended after 20 minutes without input. An
interrupted recording stops its clean copy and closes the page at once; its
steps can still be saved without a check, or recorded again. A recording
discarded while its copy starts tears down whatever the start brought up.

## The case document

`bug-case/v1` (`src/shared/bugCase.ts`) is closed and strictly parsed: steps
(the first and only navigation opens the start page), up to 20 checks (5 on the
page), target candidates without script, XPath or engine syntax, a failure
signature, and masked sensitive inputs. Targets may carry a display `label`
("Cart total"), which names the element on every surface and is never used to
find it. A check may also have to hold after a reload, in a new browser context
that keeps cookies and, when the person chooses, browser storage.

The failure signature is exactly what the recording violated. A baseline run
reproduces the bug only when it fails the same way: the same captured token,
status or count, and the reload guard holds for the wrong value too.

## Runs

| Kind | Purpose |
|---|---|
| `RECORD` | The recording session's own environment. |
| `BASELINE` | Two runs of the recorded code that qualify the bug; a control run when the qualification is more than six hours or a day old. |
| `CANDIDATE` | Two runs of the code an agent turn left, verifying the fix. |

Each run exports its tree, starts a `br-` environment, warms it up, and runs the
runner over it. The runner gets a plan with the case, the run's origins and
timeouts; it reports frames tagged with the plan hash, a per-run nonce and a
contiguous sequence. An incomplete or inconsistent stream is an infrastructure
failure, never a pass. The page cannot reach the runner's frames: they leave
over a pipe, not through the page. Requests, WebSockets and non-proxied WebRTC
to undeclared hosts are refused, in clean runs as while recording. What the
page controls in a report (paths, query keys, request matches, hang signals,
JSON values) is bounded so the page cannot make a report too large to count;
a run that exceeds its time limit is still uncounted (Couldn't verify), since
a slow machine looks the same.

A check finds its element through the target's candidates in order. A
candidate run whose check found its element by a later, weaker candidate than
the runs that reproduced the bug (by its position instead of its test id, say)
cannot say anything about the recorded element: it ends `BLOCKED` with
`TARGET_CHANGED` and the reason, never as a pass or a failure. Every run notes
checks and steps found by a fallback, and the reviewer reads those notes.

Before a run starts, the version's kept-fixed inputs are compared with the tree:
the setup files the recipe's jobs read (pinned package scripts and the files
they run) and the chosen env files by hash. A change gives `PROTECTED_INPUT_CHANGED`
or `ENV_FILES_CHANGED`, which say what changed; the person can adopt new env
files as a new version. Code a seed shares with the app is listed for the
reviewer instead of pinned.

Outcomes `REPRODUCED`, `NOT_REPRODUCED`, `PASSED` and `FAILED` count. A
qualification gets one replacement for an environment failure. A run a restart
cut short (`INTERRUPTED`) is run again; a candidate and a control run at most
three times per attempt. One rule (`owedRuns`) decides what a version still
owes, and the runs it owes are inserted in the same transaction that settles a
run, so two runs ending together never both add a replacement and none is lost
to a crash. An abort decides how a run ends whatever it was doing: a newer turn
supersedes it, Cancel cancels it, and Task Monki closing interrupts it. Cancel
stops every open run of the set. A settled run is never reopened, and nothing
runs for a task that is done, canceled or archived.

## The gate

`computeGate` derives the state from the effective version, its newest
qualification and verification attempt, and the case's observed tree:

`CAPTURED` (no check) → `REPRODUCING` → `REPRODUCED` / `NOT_REPRODUCED` /
`FLAKY` / `REPRODUCTION_BLOCKED` → `VERIFYING` → `FIX_VERIFIED` /
`STILL_FAILING` / `COULDNT_VERIFY`, and `STALE` when the worktree holds other
code than the verdict is about.

Every surface, History included, names a state the same way, from
`bugReplayClaims`: Saved without a check, Reproducing bug, Bug reproduced, Bug
not reproduced, Bug reproduced only sometimes, Bug reproduction blocked,
Verifying fix, Fix verified, Bug still failing, Couldn't verify the fix and Fix
verification out of date. A decision the person owes comes first: Clean runs
need approval, Secrets locked. While the agent has the bug: Fixing the bug.

- A run waiting on the person (approval, a locked keystore) leads the gate,
  even when newer runs wait behind it.
- When the worktree cannot be read after a turn (files it cannot copy), no
  verdict is about the code it holds: the gate is `COULDNT_VERIFY` with the
  reason until a read succeeds.
- When the worktree returns to code an earlier attempt already decided under
  the same toolchain, that verdict is reused instead of running again.
- Counts state only results: an attempt in flight, or one that could not run,
  adds no "passed 0 of 2".
- Every surface reads Before and After from the attempt the gate decided on
  (`verdictAttempt`).

**Owed verification.** After an implementation turn completes and its evidence
is captured, Task Monki captures the worktree tree, pinned under the attempt's
own ref. A verification is queued unless the tree is the recorded code, the bug
did not reproduce, or an attempt already covers that tree under this toolchain.
A requalification under a new toolchain, a new env-file version or a changed
browser-storage option is committed with its decision and queues the code the
worktree holds again. Verify fix (Verify again once a verdict exists) is
disabled, with the reason, while the agent's turn runs or when the worktree is
known to hold the recorded code, since it could only show the recorded failure
again.

**Currency.** A verdict is about one tree. The Overview and Mark done compare it
with the worktree when they show it and when the window regains focus; an edit
no Git action saw makes it `STALE`, and a comparison that reads the worktree
again clears an unreadable-worktree reason. Mark done sends the verdict it
displayed and waits for the comparison: a verdict about other code, a changed
result, or files that could not be compared are refused with the reason.

## Approval to run

Clean runs execute the task's code, including agent changes, as the person,
without a sandbox. The person approves them per task and recipe template
("Clean runs need your approval", then Approve clean runs; Cancel runs comes
first), after reading what will run: that it runs as their user without a
sandbox, that it runs again after each agent turn, that the approval covers 30
runs until Task Monki quits, then the source, data, secrets, env files, the
outside hosts, the server's network and the commands. The approval lives in
memory. A run without it waits; the Now panel asks, and every surface calls the
state "Clean runs need approval". Previewhost asks Task Monki before every
`br-` start, and only a start Task Monki is making right now, with exactly the
spec it derived, under a current approval, is approved.

## Hand-off to the agent

The bug reaches the agent the way a person's request would:

- no implementation run yet: Start implementation sends it; the first turn's
  prompt is the task goal followed by the brief, and Send to agent is not
  offered until a turn ran;
- the agent is running: Send to agent queues the instruction "Fix the recorded
  bug." behind it, carrying the bug reference;
- the agent finished: a follow-up continues the same conversation;
- the agent waits for an answer, or is starting or stopping: Send to agent is
  disabled with the reason.

The instruction carries no text from the page. The brief is built when the turn
is sent, from the case as it is then, and is added only to that turn's prompt,
never to the person's words. Task Monki's own sentences come first and last;
everything the app's pages or the recording supplied sits between two markers
derived from the bug's id, one fact per line, with line breaks, control and
direction characters removed, typed passwords and secret-like text masked, and
each value clipped. When a brief is too long (6,000 characters; review section
3,000), the recorded data is shortened, never the sentences around it. If the
person removed or replaced the bug before a queued turn ran, the turn says so
and promises no verification.

The reviewer's prompt states the result, whether it is about the code under
review, the checks, the scope, notes from the runs (fallback locators, blocked
hosts) and added lines that special-case a checked value or detect the replay
environment, those as data too. A pull request body (2,000 characters) states
the bug, its checks and whether the checked code is the PR head, with recorded
text as Markdown code, so it never renders as a link, an image or a mention.

## Evidence and persistence

Schema 31, migration 14, adds `bug_captures`, `bug_cases`, `bug_case_versions`,
`bug_case_decisions`, `bug_replay_runs` and `bug_replay_files`. Cases and runs
use optimistic revisions; a stale write is refused. Evidence (screenshots,
action, network and console logs, run frames, service logs) is stored as managed
files under `replay/<task>/<owner>/`, each kind with its own size limit, and 256
MB in all. Evidence is written without request or response bodies, and with
typed passwords and secret-like text masked in every string. Settled runs beyond
the newest eight keep their records but lose their files, except the
qualification and the attempts the verdict uses; records beyond the newest
sixty go too, releasing the trees their attempts pinned. Deleting a task removes
its rows in the deletion transaction and queues the files for collection. A
removed or replaced bug stays listed under Debug's Earlier bugs until its
evidence is deleted.

## Startup and shutdown

At startup, before agents start: a recording that was open is discarded and its
frozen tree released; runs that had not started wait for approval again; runs
that were executing become `INTERRUPTED`; exported sources and runner scratch of
runs no longer open are removed; open sets are refilled for every task with an
active bug, and a version without a qualification gets one; gates are
republished; and every `br-` environment not owned by an executing run is torn
down. Waiting runs with no approval for their task are not checked again until
one is given. Shutdown stops admitting runs, forgets every approval, interrupts
in-flight runs (each tears down its own environment), queues nothing new, and
closes the recording view; anything left is collected at the next startup. A
task that is done, canceled or archived stops its runs and recording, and its
bug becomes a record with no actions.

## Limits

- Recording needs the desktop app on macOS; clean runs also work in the
  development server.
- Checks read the app's pages and requests. Database contents are not read;
  Preview-managed databases start fresh, connections the app opens itself are
  not checked, the server's network is not restricted, and clocks are real.
- One recording at a time; up to 20 checks and 120 steps per case.

## Verification

- Pure rules: `BugCaseCompiler.test.ts`, `BugReplayVerdict.test.ts`,
  `BugReplayGate.test.ts`, `BugReplayContext.test.ts`, `BugReplayInput.test.ts`,
  `ProtectedInputs.test.ts`, `src/shared/bugCase.test.ts`,
  `src/shared/bugReplayClaims.test.ts`, `src/renderer/model/bugReplay.test.ts`.
- Store and deletion: `SqliteBugReplayStore.test.ts`.
- The queue over real storage and Git with a stand-in Previewhost and a
  scripted runner (admission, approval, shutdown, cancel, replacements,
  unreadable worktrees, pruning, saving a recording):
  `BugReplayService.integration.test.ts`.
- Hand-off through the service: `TaskManagerService.bugReplay.integration.test.ts`.
- The engine with a real browser, including WebSockets to undeclared hosts:
  `BugReplayRunner.integration.test.ts` (skipped without
  `.local/design-browser-runtime`).
- Mounted UI: `TaskDetail.dom.test.tsx` (Remove bug),
  `bug/BugRecordingWorkspace.dom.test.tsx`.
- Seeded states: the `bug` scenario set in `docs/DEV_SEEDING.md`.
