# General Agent Discourse Lifecycle

Date: 2026-07-20

This document is the source of truth for Task Monki's global Discourse
workspace: human conversation, global mentions, Direct and Panel responses,
Team review/correction, context freshness, waiting, cancellation, and recovery.
It does not change task workflow or the detached Codex review gate.

## Authority boundary

Task Monki is authoritative for:

- conversations, messages, replies, corrections, drafts, unread state, archive,
  deletion tombstones, participants, waves, jobs, concerns, and resolutions;
- selected task/repository context and the immutable context snapshot used by a
  job;
- queue, delivery, cancellation, recovery, and curated completion state;
- whether an agent result is eligible to become a visible message or concern.

Each selected agent runtime is authoritative only for its own process, session,
turn, item, model, settings, tool, and usage events. Provider output is
untrusted telemetry until Task Monki validates and persists it. Discourse does
not create a hidden task, worktree, iteration, or task workflow transition.

Curated conversation state lives in `FileDiscourseStore`. Owner-neutral
provider sessions, runs, queue entries, artifacts, diagnostics, and protocol
journals live in `FileAgentRuntimeStore`. Their records link by opaque IDs.
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
The first available result is the active combobox option, so pointer, Arrow-key,
Enter, and Tab selection all commit the same structured token.

The active board repository is never attached implicitly. A mention applies to
one message. Pinning copies a task or repository reference into a new durable
conversation context revision for later messages. Historical messages keep
their original context revision when pins change or a source becomes
unavailable.

Before agent work, Task Monki resolves selected references, canonical repository
roots, readable manifests, recent transcript, and permissions into an immutable
context snapshot. At most eight references and three filesystem roots can be
selected for one wave. Files are read-only; network, web search, MCP servers,
apps, attachments, and approvals are disabled. Untrusted repository content is
clearly separated from Task Monki instructions in the prompt.

The preview fingerprint is checked again before dispatch. If selected context
changed after preview, the wave stays planned and requires an explicit Continue
or Cancel decision. Continue confirms the current fingerprint and creates fresh
execution attestations; it does not reuse the stale preview. A source that
cannot be safely resolved is shown as unavailable or blocks the wave rather
than silently widening access.

Context generations include live Git HEAD, staged, unstaged, and untracked
working-tree evidence for each readable task worktree or repository root.
Stored Git snapshots alone do not prove freshness between Team phases.

## Response policies

`No agents`

- Appends a human message without creating a wave or consuming runtime turns.

`Direct`

- Requires exactly one mentioned available agent.
- Creates one fresh session and one attributable answer.

`Panel`

- Requires two or three mentioned available agents.
- Gives every panelist the same frozen initial transcript and context snapshot.
- Runs panelists independently. One panelist never sees another panelist's
  answer, and one failure does not erase successful answers.
- Applies complementary versioned decision lenses: Lead owns the actionable
  operating path, Skeptic develops the strongest counter-position or boundary
  condition, and Verifier audits the decisive evidence boundary. Agreement is
  allowed, but panelists must contribute distinct reasoning instead of
  paraphrasing the likely consensus.

`Team`

- Uses the canonical Lead, Skeptic, and Verifier roster.
- The Team lifecycle is Lead answer, two independent reviews, then at most one
  Lead correction when an eligible material concern exists.
- It consumes at most four agent turns.

Mentioning one agent selects Direct; mentioning two or three selects Panel.
Choosing a policy explicitly remains stable while the user selects recipients.
Choosing Team or No agents removes stale agent-recipient mentions. Task and
repository mentions remain intact.

Each responding agent has a conversation-scoped provider/model control in the
composer. A new selection starts from the first Discourse-safe app/provider
default; an existing participant starts from its current durable revision.
Direct and Panel expose the explicitly mentioned recipients, while Team exposes
the canonical three-agent roster. Drafts persist the selected runtime-qualified
model and reasoning level. Pending draft work is flushed before navigation, and
an empty conversation created during a failed first send remains owned by the
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
reasoning choice. Core resolves the live model-provider and service-tier values,
revalidates the read-only/offline capability, and rejects incomplete, removed,
or unsupported selections. A changed selection appends a participant revision
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
historical participant continues to receive the contract version recorded in
its revision.

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
resolves that window in its stored order instead of rereading the latest
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

## Targeted follow-up and synthesis

Agent messages expose actions to ask the author or ask other available agents.
These actions prepare a normal Direct or Panel follow-up with explicit
recipients and a reply link; they do not mutate the completed Team wave.

Users can select two or more visible messages and ask Lead to synthesize them.
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
  automatically replayed.

Recovery-required UI explains that Task Monki cannot safely confirm whether the
response started and offers Stop. Context reconfirmation offers Continue and
Cancel. Settled failed, stale, partial, or no-response waves can prepare a
bounded retry using a new idempotency identity; completed outputs are not
silently duplicated.

On restart, Task Monki repairs cross-store links, queued cancellations,
terminal-before-curated-message crashes, lost queue linkage, and provably
undelivered starts. The Discourse scheduler stays latched while a leased turn still
needs reconciliation. No recovery path replays a provider mutation without
proof that it was not delivered.

## Runtime compatibility

Discourse execution is routed by immutable `runtimeId` through
`AgentScopedTurnRouter`. There is no default-runtime fallback. A runtime appears
as available only when its adapter supplies an exact scoped binding that can:

- build and attest the read-only, offline execution context;
- start and interrupt a turn owned by a Discourse session/run;
- correlate deltas, terminal output, and recovery-required events back to that
  exact run.

The conversation selector receives the attested Discourse runtime catalog, not
the general task-runtime list. It may offer only runtimes that are ready and
advertise a stable Discourse capability with the required read-only/offline
execution preset. Core repeats the same validation at send time; hiding an
unsafe option in the renderer is never the security boundary.

Codex currently implements this binding with an attested App Server permission
profile. OpenCode and the registered ACP runtimes remain available for their
normal task flows but are unavailable in Discourse because their current
process boundaries cannot attest the required isolated read-only/offline scope.
Task Monki does not weaken the policy, send through Codex as a substitute, or
claim that executable discovery is sufficient. Adding another Discourse runtime
requires implementing and testing the same scoped binding in that runtime's
adapter.

## Storage, paging, and limits

Each conversation uses a private checksummed segmented event log. Segments are
bounded by event count and encoded bytes. The store also bounds message sizes,
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

## Development verification

Run `npm run dev:seed` before UI or workflow testing. The current authoritative
discourse scenarios cover human-only messages, running Team work, partial
Panel results, silent review success, author correction, queued follow-up,
context reconfirmation, unavailable historical context, recovery-required
delivery, settled cancellation, paging, drafts, and archive.

Changes to this lifecycle require focused storage/service/runtime tests plus:

```sh
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```
