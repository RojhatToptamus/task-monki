# General Agent Discourse Lifecycle

Date: 2026-09-13

This document is the source of truth for Task Monki's global Discourse
workspace: human conversation, global mentions, Direct and Panel responses,
Team comparison and responses, context freshness, waiting, cancellation, and recovery.
It does not change task workflow or the detached agent review gate.

## Authority boundary

Task Monki is authoritative for:

- conversations, messages, replies, corrections, drafts, unread state, archive,
  deletion tombstones, participants, waves, jobs, concerns, and resolutions;
- selected task/repository context and the immutable context snapshot used by a
  job;
- queue, delivery, cancellation, recovery, and curated completion state;
- whether an agent result is eligible to become a visible message or concern.

Each selected agent runtime is authoritative only for its own process, session,
turn, item, model, settings, tool, and usage events. Task Monki validates output
shape and source references before publication. Publication does not verify
the truth of a model claim. Discourse does
not create a hidden task, worktree, iteration, or task workflow transition.

Curated conversation state lives in `SqliteDiscourseStore`. Owner-neutral
provider sessions, runs, queue entries, artifacts, diagnostics, and protocol
journals live in `SqliteAgentRuntimeStore`. Their records link by opaque IDs.
Terminal provider output is durable in the runtime store before a curated agent
message or structured review result is committed.

## Conversation and context model

A conversation can be open or archived. Messages are ordinal, attributable,
and immutable after creation. A user correction appends a replacement and marks
the earlier message superseded; deletion appends a tombstone. Replies have one
visible nesting level so long exchanges remain readable.

The global `@` picker resolves three entity kinds:

- agents: explicit response recipients;
- tasks: Task Monki-owned task context;
- repositories: registry-owned repository context.

Matching results are bounded without letting a large task list consume every
slot: each matching kind receives a reserved share before unused capacity is
filled. Repositories are presented before task results so a large task list
cannot push repository context below the practical keyboard/viewport boundary.
The first available result is the active combobox option, so mouse, touch,
Arrow-key, Enter, and Tab selection all commit the same structured token.
Escape closes the picker without changing the draft.

The active board repository is never attached implicitly. A mention applies to
one message. Pinning copies a task or repository reference into a new durable
conversation context revision for later messages. Historical messages keep
their original context revision when pins change or a source becomes
unavailable.

Before agent work, Task Monki resolves selected references, canonical repository
roots, readable manifests, and recent transcript into an immutable
context snapshot. At most eight references and three filesystem roots can be
selected for one wave. Files are read-only under the selected provider profile.
Each runtime session owns its native permission identity and validates it before delivery.
The shared snapshot does not compare permission hashes across agents or fresh sessions.
Appending an agent answer does not change the captured source generations.
Task Monki does not grant app-owned web, MCP, app, attachment, dynamic-tool, or approval access.
An ACP provider can still expose its own tools when its native policy permits them.
The provider process can still use its model transport.
Untrusted repository content is clearly separated from Task Monki instructions in the prompt.

The preview fingerprint is checked again before dispatch. If selected context
changed after preview, the wave stays planned and requires an explicit Continue
or Cancel decision. Continue confirms the displayed fingerprint and checks the
captured sources again. If that snapshot is stale, the wave stops. The user must
send a new message to capture changed sources. A source that
cannot be safely resolved is shown as unavailable or blocks the wave rather
than silently widening access.

Context generations include the resolved read root and live Git HEAD, staged, unstaged, and untracked
working-tree evidence for each readable task worktree or repository root.
Stored Git snapshots alone do not prove freshness between Team phases.
When more than one repository root is readable, every phase prompt includes a
bounded filesystem guide naming the exact roots available to that provider
turn. The guide is provider-only execution context; absolute local paths do not
leak into the normal transcript or context inspector.

### What selected context supplies

A selected task supplies its title, description, phase, resolution, and recorded
Git, delivery, and review status. These records are not fresh tests or verified
agent claims. Attachments, provider transcripts, and unrelated tasks are excluded.
A task with a worktree grants only that worktree. A missing task worktree never
falls back to the repository checkout. Its recorded information remains available
without file access. A task without a worktree uses its available repository checkout.

A selected repository supplies recorded repository status and live checkout
access. It does not include task descriptions or other worktrees. An explicit
source-message or reply selection includes the message body outside the recent
transcript page. It does not expand filesystem permissions.
Context previews distinguish recorded information from live file access.

## Response policies

`No agents`

- Appends a human message without creating a wave or consuming runtime turns.
- Appears as **Note** in the composer because that label describes the user
  outcome while the stored policy retains its durable domain name.

`Direct`

- Requires exactly one mentioned available agent.
- Creates one fresh session and one attributable answer.

`Panel`

- Requires two or three mentioned available agents.
- Gives every panelist the same frozen initial transcript and context snapshot.
- Runs panelists independently. One panelist never sees another panelist's
  answer, and one failure does not erase successful answers.
- Uses neutral answer instructions. Agreement, uncertainty, and abstention are
  valid. Panelists do not need to invent differences or criticism.

`Team`

- A and B answer independently from the same initial context.
- C compares their answers and records consequential differences with source links.
- Authors respond directly to specific points. C then updates the comparison.
- A further response needs a material open point, a specific task, and a useful
  new basis. Agreement does not determine whether the process stops.
- Each wave permits at most 12 agent turns and 20 minutes from first dispatch.
  These are provisional product defaults, not evidence of optimal quality.

Current product code creates only Direct, Panel, and Team waves. The stored
contract still recognizes the earlier targeted-review, targeted-reply,
synthesis, and compact-history policy/job values so existing conversation
history remains readable and recoverable. They are compatibility-only values,
not alternate production write paths; follow-ups and synthesis requests use the
same Direct or Panel send path with explicit reply/source-message links.

Mentioning one agent selects Direct; mentioning two or three selects Panel.
Choosing a policy explicitly remains stable while the user selects recipients.
Choosing Team or No agents removes stale agent-recipient mentions. Task and
repository mentions remain intact.

Each responding agent has provider, model, and reasoning controls in the conversation sidebar.
Application settings retain the last-used mode, responder roster, and agent selections.
New conversations use these defaults across navigation and application restarts.
Older profiles without these optional defaults retain the existing app/provider defaults.
Existing participants start from their current durable revision unless a draft or explicit selection overrides it.
An unavailable saved model stays visible and blocks sending until the user selects an available model.
Direct and Panel expose the explicitly mentioned recipients, while Team exposes
the canonical three-agent roster. Drafts persist the selected runtime-qualified
model and reasoning level. Pending draft work is flushed before navigation, and
drafts also retain reply, correction, and synthesis-source intent so navigation
or restart cannot silently turn a correction into an unrelated new message. The
draft contract does not keep a second recipient list: responder identity comes
only from the typed agent selections and structured mention tokens. An empty
conversation created during a failed first send remains owned by the
composer instead of appearing as a selectable rail item. If the unsent title,
policy, or agent selection changes, the renderer first creates the replacement
and rebinds the durable draft, then deletes only the superseded owned empty
shell. Superseded shell identities remain in the idempotent create retry state
until replacement creation, draft rebinding, and cleanup all succeed, including
after an ambiguous create response. If the user edits again before that response
is recovered, the exact earlier create request is replayed first so its shell
identity joins the cleanup set. Navigation cleans up only a draftless empty shell; a successfully
checkpointed draft keeps its shell and makes it available in the conversation
rail. It never deletes a conversation that has acquired a message.

The renderer sends only a runtime ID, runtime-qualified model ID, and optional
reasoning choice. Core resolves the live model-provider and service-tier values.
It revalidates the shared read-only capability and rejects unsupported selections.
A changed selection appends a participant revision
and advances only that stable participant's `currentRevisionId`. Earlier
revisions and job assignments remain immutable and attributable; the new
revision applies to future work without rewriting conversation history.
The human message, message-context revision, all changed/new participants, their
immutable revisions, the exact assignments, and an accepted response intent are
committed in one event after durable validation. Archived, invalid, or
conflicting retries cannot leave a partial message or roster/model update
behind. The accepted intent and eventual wave store the same semantic send
fingerprint; an identical lost-response retry can recover without depending on
changed provider availability, while a changed retry is rejected before any
mutation. Conversation-create fingerprints carry an explicit semantic version.
Pre-version records are recognized from their durable initial participant
configuration, so an exact retry across an app upgrade is accepted while a
changed provider/model request still conflicts.

Before an agent-directed send is persisted, every selected participant is
revalidated against live runtime availability, a scoped-runtime binding, and
the exact model, model-provider, reasoning, and service-tier settings in its
immutable participant revision. Drift blocks the send; Task Monki does not
silently reroute a historical participant. Role contracts are versioned, and a
historical job continues to receive the contract version recorded in
its revision. New stages also check the saved model and settings before run
preparation. No fallback model is selected for an unavailable assignment.

## Renderer interaction contract

The composer presents Note, Direct, Panel, and Team as one compact mode control.
Its closed state contains only the mode icon, title, and disclosure chevron;
the open menu owns the short explanation for each mode. The selected option is
identified by a checkmark and programmatic selected state, with neutral hover
and focus treatment rather than a color-only highlight. Changing the composer
mode affects the next message only. An accepted intent and any active wave keep
the policy with which they started.

Responder controls appear in the docked conversation sidebar.
Direct and Panel expose the selected agents. Team exposes A, B, and C.
Provider, model, and reasoning selections remain
attached to the participant revision described above, while core resolves any
service-tier value, so the UI does not maintain a parallel routing source of
truth. Configuration can be opened and dismissed without replacing the draft,
reply target, mentions, or context selection.

The message field starts as a practical multiline composer, grows with its
content to a bounded height, then scrolls internally. Mention results use a
combobox interaction shared by agent, task, and repository entities and support
pointer, touch, Arrow keys, Enter, Tab, and Escape. Reply, copy, more, context,
configuration, navigation, and mode actions use accessible icon controls with
stable labels, tooltips, hover treatment, and visible keyboard focus. All
Discourse glyphs are exported through `DiscourseIcons.tsx`, backed by Lucide,
so navigation and conversation actions do not introduce one-off SVG styles.

At compact widths, conversation history collapses when the settings sidebar opens.
The settings sidebar stays beside the conversation and never covers its content.
Opening history at these widths closes the settings sidebar.
Controls preserve their meaning and keyboard behavior when labels condense.
Model menus stay within the viewport and have explicit close behavior.
Light, dark, increased-contrast, and reduced-
motion behavior inherit the shared Task Monki tokens and accessibility rules in
`DESIGN.md`.

## Wave ordering and waiting

A message and its accepted response intent are written atomically and
idempotently before fallible context/runtime preparation. Wave planning consumes
that immutable intent. If preparation stops before the wave is durable, startup
or the explicit **Resume** action can continue it by accepted-intent ID without
duplicating the message or rewriting the participant configuration. **Cancel**
settles the intent while preserving the user message; its message cannot be
deleted and its conversation cannot be archived until that choice is made. The
conversation summary surfaces the gap as needing attention, while a transient
recovery failure cannot prevent the application from starting. Pending intents
and active waves share the same bounded eight-response queue.

If planning fails after acceptance, the renderer reconciles by the durable
client-message ID, adopts the conversation immediately, clears the already-sent
draft, and presents Resume/Cancel instead of reporting the message as unsent.
The same client-message ID is stored with the conversation-scoped draft before
every delivery, and a required checkpoint failure aborts the send. Restart
reconciliation matches both accepted agent sends and durable human-only
messages, removing the sent draft instead of restoring it as a second sendable
message. Human-only recovery uses the conversation event log's indexed client
message identity rather than only the newest transcript page, so an older sent
message cannot restore a stale draft. An interrupted response blocks new composer work until the user resumes
or cancels it. Renderer reconciliation begins only after the delivery API is
actually invoked. Failures while checkpointing a draft or previewing context
leave the current composer in place and are never presented as ambiguous
delivery.
Routine provider events are coalesced into quiet background refreshes; only an
initial load or an explicit stale/error recovery blocks composer actions.

Acceptance also freezes the exact bounded visible-message ID window. Recovery
resolves those exact messages in transcript order instead of rereading the latest
transcript, so an earlier interrupted response never receives prompts that were
added later.

Within one conversation, a later response wave may be durably queued while an
earlier wave is active, but it is not dispatched until the earlier wave settles.
This preserves conversational order. At most eight non-settled waves can exist
in one conversation.

Discourse turns use one durable owner-neutral scheduler. It permits two active
Discourse turns, no more than two for one conversation, and one per runtime
session. Dispatch checkpoints for jobs in one wave are serialized so their
shared wave revision cannot race; provider turns run concurrently after their
starts are acknowledged. Owner fairness and bounded aging apply within this
queue. Task implementation dispatch remains owned by `AgentOrchestrator`; the
current release does not claim one aggregate task-plus-Discourse capacity cap.
A queue lease represents capacity, not completion, and remains owned until
authoritative terminal or recovery resolution.

## Team review and correction

This section describes historical policy-1 waves only. New Team waves use the
comparison protocol below. Historical prompts and records remain readable.

The Lead first creates a normal attributable answer. Skeptic and Verifier then
receive fresh provider sessions with the same immutable context snapshot and
the exact Lead message as their review target. They do not see each other's
review.

Each reviewer must return bounded structured JSON with one of:

- concerns;
- no concern found with complete required access;
- abstained with an explicit limitation.

Every concern identifies the target claim, category, severity, confidence,
evidence status, reason, evidence, and suggested resolution. Invalid structured
output fails that reviewer job; it is never rendered as a raw review message.
Exact duplicate signals remain auditable but are marked redundant and do not
trigger another correction. Advisory or redundant concerns remain visible but
are not automatic correction work.

When at least one non-redundant material or blocking concern is eligible, Lead
gets one fresh correction session containing the original answer and only those
eligible concern IDs. The correction must return a structured outcome:
revised, defended, partially revised, acknowledged unresolved, or abstained.
A non-abstaining correction appends a new attributable answer linked to the
original Lead answer. The original remains in transcript order with
`SUPERSEDED` status, while the replacement records `supersedesMessageId` so the
UI can label the history as corrected without rewriting it. Concern resolutions
point to the correction job and, when present, the correction message.
Historical answers and reviewer records are never deleted.

The UI always leaves a durable review receipt. A silent successful review says
that both reviewers found no material concerns with complete access. Partial,
failed, and abstained reviews remain explicit; silence is never interpreted as
agreement.

## Adaptive Team protocol

`TEAM` policy version 2 uses the existing wave, jobs, scheduler, and runtime store.
`DiscourseTeam.nextTeamStep` derives the next jobs from durable results. It does
not store a second lifecycle. Every job uses a fresh runtime session and the
model settings from its immutable assignment.

A and B see the accepted transcript, question, and selected context. Neither
sees the other current answer. C sees both original answers and all completed
responses from this wave. Authors receive C's specific requests and completed
earlier messages. Authors in the same response batch do not see each other's
new responses. New user messages do not enter an active wave implicitly.

C returns a summary and up to 16 points. Each point records source message IDs,
an explanation, evidence claims, confidence, importance, and a resolution state.
Source IDs locate arguments. They do not prove factual claims. Empty point and
evidence lists are valid. C cannot erase an earlier point ID in an update.
Original answers and responses remain separate messages after C changes its
interpretation. No majority vote or winner field exists.

Each author response contains a stance, answer, reason, and evidence for every
assigned point. Stances include revision, defense, clarification, withdrawal,
uncertainty, and abstention. Authors can record new issues or corrections to C.
An abstention-only batch with no new issues stops without another comparison.
An update reconstructs C's context from public messages. It does not depend on
hidden provider memory or private chain-of-thought.

Continuation requires all of the following:

- An open material point.
- An assigned author and a specific response or read-only investigative task.
- A stated potential effect on the decision.
- A visible non-comparator message that supplies an unanswered or new basis.
- Capacity for the response batch and C's subsequent update.

Rephrasing a request on already-seen inputs does not justify another response.
These structural rules limit repetition. They do not prove that a new argument
is sound or useful. Agents can still produce correlated errors or false criticism.

C can finish with a useful comparison, missing evidence, a user question, or an
unresolved disagreement. Each state settles the wave and releases completed
runtime capacity. The UI preserves the stopping reason. A follow-up action opens
an empty composer with the original question linked. Only a new user send
authorizes another bounded response with current context.

Evidence gathering stays within the existing read-only scope. A missing trace,
external source, write permission, or preference requires user involvement.
Suggested tests are not executed tests. Discourse never changes review findings,
PR approval, task acceptance, or delivery state.

Malformed output fails that job. Task Monki retains the raw runtime output and
does not run a repair call. An author failure prevents a claimed two-answer
comparison. A failed response or comparison preserves all completed messages
and settles the wave as incomplete. The UI marks earlier comparisons when
newer responses exist, even if the update fails.

Accepted sends without a policy version retain policy 1. New sends record their
version explicitly. These optional values use the existing JSON payloads; no
database migration or new table is needed. New sends use neutral role contracts
and new participant revisions. Historical job assignments and messages do not change.

The deadline starts at first dispatch, not queue entry. An owned timer requests
interruption after 20 minutes. Dispatch and continuation also check the durable
start time. Restart does not reset the deadline. Stop handles running and queued
jobs in the same batch. Unknown delivery keeps its recovery fence and capacity.
The deadline is not a hard provider billing or process-termination guarantee.

## Targeted follow-up and synthesis

Agent messages expose actions to ask the author or ask other available agents.
These actions prepare a normal Direct or Panel follow-up with explicit
recipients and a reply link; they do not mutate the completed Team wave.

Users can select two or more visible messages and ask A to synthesize them.
The resulting message records the exact selected source message IDs. The prompt
requires a concise synthesis that preserves material disagreement, uncertainty,
and context limitations. Selection does not imply that an agent endorsed every
source.

## Stop, failure, and recovery

Stop intent is durable before provider interruption:

- an undispatched queued wave is canceled only after its runtime run is proven
  not delivered and its queue entry is canceled;
- an active wave persists interrupt-send state before `turn/interrupt`;
- an acknowledged interrupt has a bounded terminal deadline; an authoritative
  provider terminal wins a concurrent acknowledgement checkpoint, while a
  missing terminal becomes recovery-required instead of leaving the UI in
  Stopping indefinitely;
- an ambiguous start or interrupt becomes recovery-required and is never
  automatically replayed. Repeating Stop preserves the visible stopping intent
  and the scheduler lease until provider terminal evidence arrives. A
  definitively not-delivered interrupt may be retried only by a new explicit
  Stop action.

Recovery-required UI explains that Task Monki cannot safely confirm whether the
response started and offers Stop. Context reconfirmation offers Continue and
Cancel. Settled failed, stale, partial, or no-response waves can prepare a
bounded retry using a new idempotency identity; completed outputs are not
silently duplicated.

On restart, Task Monki repairs cross-store links, queued cancellations,
terminal-before-curated-message crashes, lost queue linkage, and provably
undelivered starts. Duplicate or missing runtime records, invalid session/job
links, and incomplete terminal evidence are projected into durable job and wave
recovery state rather than existing only in a startup report. Runtime records
that claim the same conversation, wave, and job are fenced even when their
attempt or generation identity is stale; only the exact durable attempt may be
dispatched. Runtime scope—not a stale curated run ID—defines ownership, so
recovery never mutates task work or another conversation/job. A terminal from
the authoritative attempt is not projected into the transcript until every
delivered sibling claim also reaches terminal. A leased acknowledged or
ambiguous turn keeps its capacity while fenced and is released only after
provider terminal evidence. The Discourse
scheduler stays latched while a leased turn still needs reconciliation. A
dispatch-infrastructure failure exits the current lease cycle and retries under
capped exponential backoff, preventing both a silent stall and a tight re-lease
loop. No recovery path replays a provider mutation without proof that it was not
delivered.

## Runtime compatibility

Discourse execution uses the immutable `runtimeId` through `AgentOrchestrator`.
There is no default-runtime fallback.
Every ready runtime and model is available.
The prompt tells the agent not to modify files, and the adapter applies its native
restriction when one is available.
The adapter must use the common runtime operations to:

- build and attest the provider-native read-only execution context.
- start and interrupt a turn that a Discourse session and run own.
- correlate deltas, terminal output, and recovery-required events with that
  exact run.

The conversation selector receives the Discourse runtime catalog, not the general
task-runtime list. It offers every ready runtime and model.
Core repeats the same validation at send time.
The renderer is not the security boundary.

Codex uses an attested App Server read-only profile.
OpenCode uses a dedicated `--pure` session and native deny rules.
Cursor ACP uses native Ask mode and rejects every permission request.
Claude Agent ACP uses plan mode, although a packaged mutation probe showed that
this mode can still complete a Write tool call.
Grok Build on macOS uses a separate process with its native read-only sandbox.
All five current profiles can participate in Discourse.

OpenCode and Cursor still run with normal user permissions. Their policies are
not operating-system sandboxes. Grok uses a separate sandboxed ACP process for
Discourse. Normal Grok Tasks and Design turns keep the writable ACP process.
Task Monki rejects Grok repository and Git control paths in the sandbox's
writable temp and state locations.

Before delivery, `AgentOrchestrator` records repository state for every context root.
After terminal output, it compares the current state with that record.
A changed or unreadable repository fails only that participant turn.
Task Monki leaves detected changes in place as evidence.
Other Panel or Team participants can still complete independently.

Task Monki does not weaken the policy or send the request through another runtime.
Executable discovery alone does not enable Discourse.
Another runtime must implement the common operations and pass the same policy
tests.

## Storage, paging, and limits

Conversations and typed events use the existing SQLite store. Runtime output
and protocol journals remain under their existing runtime owner. The store bounds message sizes,
context manifests, transcript input, wave output, drafts, summaries, open
conversation indexes, queued waves, and the total events/segments per
conversation. Transcript and conversation paging use opaque cursors; renderer
state does not load the complete history by default.

Agent text deltas are coalesced and byte-bounded. Normal UI shows compact
attribution, model, context freshness, review receipts, and material concerns.
Raw protocol traffic, structured wire output, and provider diagnostics remain
in private debug/runtime artifacts.

Every initial, review, and correction prompt is assembled and budgeted from the
same non-overlapping sections before runtime records or provider delivery:
trusted system/role instructions, the current human request, exact targets,
context manifests, background transcript, and phase-visible output. Structured
review concerns are bounded phase output and remain inside an explicit untrusted
boundary followed by trusted correction instructions. The budget also includes
durable completed output bytes already produced by the wave. The snapshot
budget records only its reusable frozen-context baseline; complete prompt
budgets are evaluated per job. A job that exceeds these limits persists an
auditable error with actual and limit values and fails while still `NOT_SENT`;
one over-budget Panel member does not fabricate delivery or erase independently
runnable members.

The app uses a 128,000-token planning ceiling, reduced to the model capacity
when the runtime explicitly reports a smaller value. OpenCode supplies its
reported context limit. An absent model limit remains unknown. The 16,000-token
output reserve and byte estimates do not enforce a provider output-token cap.
The runtime store retains provider usage observations without inventing missing values.

## Development verification

Run `npm run dev:seed` before UI or workflow testing. The current authoritative
discourse scenarios cover human-only messages, running Team work, partial
Panel results, silent review success, author correction, queued follow-up,
context reconfirmation, unavailable historical context, recovery-required
delivery, settled cancellation, paging, drafts, and archive. Adaptive Team seeds
cover completed comparisons, missing user decisions, author responses, failures,
and stale context. Provider-inert seed startup does not recover projected jobs
or arm their deadline timers.

Changes to this lifecycle require focused storage/service/runtime tests plus:

```sh
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```
