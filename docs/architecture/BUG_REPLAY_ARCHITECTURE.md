# Bug Replay Architecture

Date: 2026-10-18

Bug Replay turns a bug the person saw in the running app into expectations Task
Monki checks itself. The person records the bug in a clean copy of the task's app
and marks what is wrong; Task Monki replays it to confirm the bug on the recorded
code, hands it to the task's agent, and replays every agent turn on a fresh clean
copy to verify the fix. The interface calls a clean run a replay and a check an
expectation.

Read this before changing `src/core/bugReplay`, the recording host
(`src/electron/BugRecordingViewHost.ts`), the Bug Replay store, the bug brief in
prompts, or any surface that shows a bug.

## Authority

- **Task Monki owns the verdict.** A bug's state comes only from runs Task
  Monki executed with its own runner and evaluated with `BugReplayVerdict`. The
  agent's claims ("fixed and tested") are provider telemetry, never evidence.
- **The person owns the expectation.** Only the person creates a case
  version: by saving a capture, or by changing a saved bug's expectations.
  Agents, recipes and renderer requests cannot write one. The bug
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
| `recorder/*` | The recorder injected into an isolated world (actions, requests, console), and pointing through the browser's inspect mode. |
| `BugCaseCompiler` | A sealed recording plus the person's checks → a strict `bug-case/v1` document, its failure signature and what the recording showed for each check. |
| `BugCaseRevision` | A saved version plus the person's changes → the next version's document and failure signature, by the compiler's rules; the editor's rows. |
| `BugReplayService` | Cases, versions, runs, scheduling, qualification, verification, refills, hand-off tracking, pruning, startup recovery. |
| `ReplayDerivation`, `ReplayEnvironment`, `ReplaySourceFreezer` | The `br-` Previewhost spec derived from the task's recipe, its start and teardown, and frozen source exports. |
| `ReplayAuthorization` | The leases that let a task run clean copies, given for now or from an approval kept for its repository, and Previewhost's per-start approval. |
| `BugReplayRunner`, `runner/*` | The runner process (Task Monki's Node, playwright-core, Chrome for Testing) and its framed output. |
| `BugReplayGate`, `BugReplayVerdict` | Pure rules: what a run means, and the bug's state from its runs. |
| `BugReplayContext` | Everything that leaves Task Monki about a bug: the agent brief, the reviewer section, the pull request block. |
| `BugReplayViews` | What the renderer reads: words, lines and actions already decided. |
| `SqliteBugReplayStore` | Durable records and evidence files. |

## Recording

Record bug is offered on the Preview tab of a normal task with a worktree and a
preview recipe, in the desktop app on macOS, while the task is open, and in the
Ready task's Now panel beside Start implementation while the task has no bug: a
bug recorded first goes to the agent with its first turn. It is shown but
disabled on the Preview tab while the agent changes the task's files, while
another task is recording, or when evidence storage is full; the reason is
stated beside it.

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
   frozen export, on fresh data. The person's own preview keeps running. The
   start is shown as steps in the order they run (copying the files, installs,
   databases, other jobs, the app's processes, opening the app), each with its
   time, from Previewhost's service states.
5. **Record.** The page loads in the native view at a pinned 1280×800 viewport,
   framed with its own bar: Reload, where the page is, and the recorded size.
   Until the first step, the address takes a path of the app's own origin, and
   the start step becomes that page, so a recording starts where the bug is.
   The view's session is private to the recording, allows only the run's own
   origins (plus `about:blank` and same-view `data:`/`blob:` subresources),
   denies popups, downloads and permission prompts, and is cleared when the
   recording ends. The page gets the browser settings its replays get, which
   the case keeps: the system's color scheme, the display's pixel density, a
   browser's user agent without Task Monki's or Electron's name, the machine's
   locale (also as the page's languages) and time zone, no HTTP cache and no
   service workers. A steps rail beside the page shows what was recorded as it
   happens: each step a replay takes, inputs it cannot replay, requests that
   failed or were refused, and uncaught errors, the newest 80 rows, sent at
   most four times a second. A typed password is kept in the case so runs can
   type it again, masked on every surface; the composer says so.
6. **Mark.** Mark bug seals the window since the last action, notes the page's
   scroll, takes the screenshot and starts pointing. Pointing never blocks the
   person: Stop pointing, Escape, Back to recording and Discard stay available,
   and marking returns at once while the pick arrives in the background.
   Pointing is the browser's own inspect mode, set through the view's debugger
   on the page and on each embedded frame that is a target of its own. The
   browser draws the highlight outside the page and takes the pointer before the page's input
   handling, so the page gets no pointer input while the person points, and
   nothing it listens for, dispatches or draws takes part in a pick. The click
   that picks, its release included, never reaches the page. The picked node is
   read in the top frame's recorder world; inside a shadow tree its host is the
   pick. An element inside an embedded frame is not picked: pointing ends and
   the composer says why. Stop pointing, Escape and Back to recording leave
   inspect mode, and Escape pressed while the page has focus never reaches it.
   A pick keeps where its element sat, placed on the screenshot by the scroll
   the screenshot was taken at. The browser keeps the picked element
   highlighted until its numbered outline is drawn, and each element an expectation reads
   keeps a numbered outline on the page while the bug is marked.
7. **Name.** One rule names an element on its pick, in its expectations and in
   their evidence: its label or accessible name, its test id read as words
   ("noteCount" is "Note count"), the words beside it on its own line, or its
   placeholder, never text that repeats what an expectation reads. The bug's
   suggested name follows its first expectation and states what should be true
   ('Cart total should read "$45.00"'), so it still reads right once the fix is
   verified; until the expectation differs from what the element showed it
   states the observation, and without an element there is no suggestion.
8. **Expect.** Each picked element gets an expectation, whose value takes focus
   with its text selected. A write request the marked action sent is expected
   to get no server error and, when it was sent once, to be sent once; Should
   succeed is the person's choice, so an app's own 4xx answer never becomes the
   bug by default. No page error is offered when the page raised errors. It
   counts uncaught errors from the marked action's start (a fill's first
   keystroke, the start page's load) to the checks, in the recording and in
   every replay alike, so an error an outside script raised earlier is never the
   bug's; it is part of the failure only when that action raised one.
   An expectation the person removes stays removed when they point at another
   element (the draft counts the picks it has taken in).
9. **Save.** Save and reproduce needs at least one expectation the recording
   itself violated (the failure signature); otherwise the capture can only be
   saved as steps, without expectations. Saving pins the recorded tree, then
   commits the capture (with each step's kind and the picked elements' places),
   the case, its approved version (with what the recording showed for each
   check) and the version's two qualification runs together, so saved
   expectations are always reproduced. Saving replaces the
   task's current bug, which moves to Earlier bugs. A save that fails deletes
   the evidence it wrote and returns the person to the composer.

A recording ends as interrupted when the environment stops, the view crashes or
the 60 minute limit is reached, and as ended after 20 minutes without input. An
interrupted recording stops its clean copy and closes the page at once; its
steps can still be saved, or recorded again. A recording discarded while its
copy starts tears down whatever the start brought up.

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

## Changing expectations

Edit expectations, in the Bug section's menu and beside Record again when the
bug did not reproduce, opens the saved expectations as the capture panel listed
them, each with what the recording showed. The person changes what an element
should read, contain or do, Also after reload, a request's status or a JSON
value, or removes an expectation; removing a request removes the values that
read its answer. Nothing is added: a new expectation needs a new recording.

Each version keeps what the recording showed for every check (`recorded`: the
picked element's text, value, visibility, count and name; the count and
answers of the requests a check counts; the JSON values at a checked pointer;
whether the marked action raised a page error). `reviseBugCase` works the
failure signature out again from it by the compiler's own rules, so a changed
version describes the bug the recording shows. Check ids stay through every
version, so an earlier run's result stays tied to the check it read. A change
the recording would no longer show as a bug is refused with the reason ("Cart
total matches the recording", "No expectation failed in the recording"), and so
is a value left without its request's status. The editor asks the same rules as
the person types and keeps Save and reproduce disabled, with the reason beside
it, while a change cannot be saved. A bug saved before
versions kept the recording's observations cannot be edited; it says to record
it again.

Saving commits together: version N+1 with `EXPECTATION_CHANGED` and the change
in words as its reason, its `APPROVED` decision, the replaced version's
`SUPERSEDED` decision, and the new version's two qualification runs. A save
against another version than the editor showed is refused. Open runs of the
replaced version stop as `SUPERSEDED`, and admission settles any left behind
the same way before it checks anything else. The code the worktree holds is then
verified again by an attempt that waits for the qualification, so the changed
expectations reproduce on the recorded code before a fix can be verified
against them, and a turn that ends meanwhile owes its own verification. A name
Task Monki suggested follows the first element expectation; a name the person
wrote stays. `SIGNATURE_RELAXED` is kept for accepting a different recorded
failure as the bug, which nothing offers yet.

Results about a replaced version are earlier context, never the current
verdict: the gate, the Before and After table, the pictures, the agent's brief,
the reviewer's section and the pull request block read the version in force
only. Replays lists earlier runs as "earlier expectations" with their word in
neutral ink, and each opens against the expectations it checked. History
records "Expectations changed" with the change.

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

Each run opens the page with the case's browser settings, as the recording
did. Screenshots keep one pixel per CSS pixel at any density.

After the expectations are read, the runner scrolls the first element it found
into view and reports where each found element sat in the final screenshot;
core accepts only boxes for the case's own page expectations, at most five, on
the final screenshot. Each observation keeps a short value for results tables
('"$40.00"', '200', 'Not shown') beside its sentence, and its box.

A check finds its element through the target's candidates in order. A
candidate run whose check found its element by a later, weaker candidate than
the runs that reproduced the bug (by its position instead of its test id, say)
cannot say anything about the recorded element: it ends `BLOCKED` with
`TARGET_CHANGED` and the reason, never as a pass or a failure. Every run notes
checks and steps found by a fallback, and the reviewer reads those notes.

Before a run starts, the version's kept-fixed inputs are compared with the tree:
the setup files the clean copy's jobs read (pinned package scripts and the files
they run, including the install scripts of an install the clean copy adds) and
the chosen env files by hash. A change gives `PROTECTED_INPUT_CHANGED`
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
`bugReplayClaims`: Bug recorded, Reproducing bug, Bug reproduced, Bug not
reproduced, Bug reproduced sometimes, Replay blocked, Verifying fix, Fix
verified, Bug still failing, Couldn't verify the fix and Verification out of
date. A decision the person owes comes first: Replays need approval, Secrets
locked. While the agent has the bug: Fixing the bug.

- A run waiting on the person (approval, a locked keystore) leads the gate,
  even when newer runs wait behind it.
- When the worktree cannot be read after a turn (files it cannot copy), no
  verdict is about the code it holds: the gate is `COULDNT_VERIFY` with the
  reason until a read succeeds.
- When the worktree returns to code an earlier attempt already decided under
  the same toolchain, that verdict is reused instead of running again.
- Counts state only results, one polarity per side ("reproduced 2 of 2",
  "passed 2 of 2"): an attempt in flight, or one that could not run, adds no
  "passed 0 of 2".
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

Replays execute the task's code, including agent changes, as the person,
without a sandbox. Nothing runs until the person approves it ("Replays need
approval") after reading what will run, as label and value rows: runs as their
user without a sandbox, a copy of the task's files with the agent's changes,
after each agent turn, 30 replays until Task Monki quits, then the data,
secrets, env files, the network and outside hosts, and the commands. The Now
panel states what waits ("2 replays wait to check the fix") with the rows under
What runs. An approval is for exactly those rows: its digest covers the
recipe's template digest, the env files replays get and every outside host they
call, and approving names that digest, so nothing else is approved. Cancel comes
first, then the two ways to approve:

- **Approve replays** gives the task a lease in memory for 30 environment
  starts, which ends when Task Monki quits.
- **Always approve in this repository** keeps the approval for the task's
  repository until the person revokes it. Task Monki keeps only what the task
  asks to approve at that moment, as its sheet states it, with the commands, env
  files and hosts the person read; a repository keeps its newest ten. Any task
  of that repository whose replays derive the same digest gets a lease without a
  start bound, for recording and runs alike and after a restart. A recipe that
  runs other commands, gets other env files or calls other hosts derives another
  digest and asks again.

Settings lists kept approvals under Repositories, Replay approvals. Revoking one
deletes it and ends every lease it gave at once, so the next replay of that
recipe asks again; runs already started finish. A run without an approval waits,
and every surface calls the state "Replays need approval". Previewhost asks Task
Monki before every `br-` start, and only a start Task Monki is making right now,
with exactly the spec it derived, under a current lease, is approved.

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

The turn's message in the Agent tab shows the bug as an attachment, read from
the hand-off events and the instruction's bug reference; it opens the bug on the
Overview, and the turn's View sent prompt shows the exact brief.

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

## Surfaces

- **Overview.** The Bug group leads with the verdict: the bug's name and state
  (unless the Now panel holds its step), the page before the fix and after it,
  each framed on the first checked element with every checked element
  outlined, and an Expected, Before and After table of what each expectation
  showed. Before is the run that reproduced the bug, or the recording until one
  counted; After is the verdict's decisive run, marked as earlier code while the
  verdict is out of date or could not be checked. A picture opens both sides in
  one place, switched by the segment or the arrow keys. Replays lists the runs;
  each opens a drawer with its page, what each expectation saw, how far its
  steps got, and where it ran (environment facts and what replays do not
  control); a run of replaced expectations reads as earlier. Steps lists the
  recorded steps by kind. Edit expectations opens the editor in the same
  drawer.
- **Review.** The brief's Bug block states the word and the Before and After
  lines.
- **Board, Inbox, History.** The state words above.

## Evidence and persistence

Task store schema 31 and SQLite migration 15 add `bug_captures`, `bug_cases`, `bug_case_versions`,
`bug_case_decisions`, `bug_replay_runs` and `bug_replay_files`. Cases and runs
use optimistic revisions; a stale write is refused. Versions are insert-only;
each keeps what the recording showed for its checks in its payload, bounded
to 16 distinct answers or values per check. Like the case document, it can
hold a typed password, which every surface masks. Migration 16 adds
`bug_replay_approvals`, one row per repository and approval digest, which goes
with its repository and is deleted when revoked, and indexes the child columns
deleting a task's bug looks up. Evidence files are screenshots, the
recording's and each run's, at most 1 MB each, stored as managed files under
`replay/<task>/<owner>/`; what a run observed stays in its record. Once 256 MB
is stored in all, no new recording starts until earlier evidence is deleted.
Settled runs beyond
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
down. Waiting runs with no lease for their task are not checked again until one
is given, unless their repository kept an approval that may cover them. Shutdown
stops admitting runs, forgets every lease (kept approvals stay), interrupts
in-flight runs (each tears down its own environment), queues nothing new, and
closes the recording view; anything left is collected at the next startup. A
task that is done, canceled or archived stops its runs and recording, and its
bug becomes a record with no actions.

## Limits

- Recording needs the desktop app on macOS; clean runs also work in the
  development server.
- Checks read the app's pages and requests; an element inside an embedded
  frame cannot be checked. Database contents are not read;
  Preview-managed databases start fresh, connections the app opens itself are
  not checked, the server's network is not restricted, and clocks are real.
- One recording at a time; up to 20 checks and 120 steps per case.

## Verification

- Pure rules: `BugCaseCompiler.test.ts`, `BugCaseRevision.test.ts` (changed
  expectations against the recording), `BugReplayVerdict.test.ts`,
  `BugReplayGate.test.ts`, `BugReplayContext.test.ts`, `BugReplayInput.test.ts`,
  `ProtectedInputs.test.ts`, `src/shared/bugCase.test.ts`,
  `src/shared/bugReplayClaims.test.ts`, `src/renderer/model/bugReplay.test.ts`.
- What an approval covers, and every recipe a clean copy refuses:
  `ReplayDerivation.test.ts`; which starts Previewhost may run under a lease:
  `ReplayAuthorization.test.ts`; which env files a recording offers:
  `BugRecordingService.test.ts`; a report the runner must not count:
  `BugReplayRunner.test.ts`.
- Store and deletion, payloads checked against their rows, and kept approvals
  across restarts, their bound and revocation: `SqliteBugReplayStore.test.ts`;
  the upgrade from every earlier numbering: `DatabaseMigrations.test.ts`; the
  gate's events in the projection: `reducer.test.ts`; a capture of an edit made
  in the second the index was written: `ReviewSnapshotStore.integration.test.ts`.
- The queue over real storage and Git with a stand-in Previewhost and a
  scripted runner (admission, approval, shutdown, cancel, replacements,
  unreadable worktrees, pruning, saving a recording, changing expectations,
  approvals kept across a restart, a changed recipe, another repository and
  revocation, a newer attempt or a cancel settling a set in one step, a stale
  verdict, recovery after a crash, and a recording that stops while marked):
  `BugReplayService.integration.test.ts`.
- Hand-off through the service, and Mark done refusing a verdict about other
  code: `TaskManagerService.bugReplay.integration.test.ts`.
- Recording and replay end to end in real browsers: a bug recorded with the
  recorder, replayed until it reproduces and then passes, with the page seeing
  the same browser settings in both, each step found by the locator the
  recording named, screenshots at CSS size, page errors and WebSockets to
  undeclared hosts: `BugReplayRunner.integration.test.ts` (skipped without
  `.local/design-browser-runtime`).
- Pointing with a real browser on a page that swallows, forges and watches
  input, with picks in a shadow tree and in same-origin, same-site and
  cross-site frames, the pick's highlight until its outline, Stop pointing and
  Escape: `recorder/RecorderSession.integration.test.ts` (skipped without
  `.local/design-browser-runtime`); placing a pick on the screenshot, the live
  steps and bounded bodies: `recorder/RecorderSession.test.ts`; what the
  recording view lets through, the settings it records with, and Escape while
  pointing: `src/electron/BugRecordingViewHost.test.ts`.
- Mounted UI: `TaskDetail.dom.test.tsx` (Remove bug),
  `bug/BugRecordingWorkspace.dom.test.tsx` (including the approval's order),
  `bug/BugCapturePanel.dom.test.tsx` (expectations, focus and naming),
  `bug/BugSection.dom.test.tsx` (the verdict, the results table, the replay
  drawer, the Now panel's approval, editing expectations and earlier replays),
  `bug/ReplayApprovalSettings.dom.test.tsx` (listing and revoking kept
  approvals).
- Seeded states: the `bug` scenario set in `docs/DEV_SEEDING.md`.
