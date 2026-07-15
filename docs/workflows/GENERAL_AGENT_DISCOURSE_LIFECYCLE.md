# General Agent Discourse Lifecycle

Date: 2026-07-13

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

Codex is authoritative only for its own process, thread, turn, item, model,
settings, tool, and usage events. Provider output is untrusted telemetry until
Task Monki validates and persists it. Discourse does not create a hidden task,
worktree, iteration, or task workflow transition.

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

`Team`

- Uses the canonical Lead, Skeptic, and Verifier roster.
- The Team lifecycle is Lead answer, two independent reviews, then at most one
  Lead correction when an eligible material concern exists.
- It consumes at most four agent turns.

Mentioning one agent selects Direct; mentioning two or three selects Panel.
Choosing a policy explicitly remains stable while the user selects recipients.
Choosing Team or No agents removes stale agent-recipient mentions. Task and
repository mentions remain intact.

Before an agent-directed send is persisted, every selected participant is
revalidated against live provider availability and the exact model, reasoning,
and service-tier settings in its immutable participant revision. Drift blocks
the send; Task Monki does not silently reroute a historical participant.

## Wave ordering and waiting

A message and its response wave are written idempotently before provider work.
Within one conversation, a later response wave may be durably queued while an
earlier wave is active, but it is not dispatched until the earlier wave settles.
This preserves conversational order. At most eight non-settled waves can exist
in one conversation.

All task and discourse turns share one durable scheduler. The scheduler permits
two active turns globally, no more than two for one conversation, and one per
provider session. Task foreground work has higher initial priority; bounded
aging and owner fairness prevent discourse starvation. A queue lease represents
capacity, not completion, and remains owned until authoritative terminal or
recovery resolution.

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
original Lead answer. Concern resolutions point to the correction job and, when
present, the correction message. Historical answers and reviewer records are
never rewritten.

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
- an ambiguous start or interrupt becomes recovery-required and is never
  automatically replayed.

Recovery-required UI explains that Task Monki cannot safely confirm whether the
response started and offers Stop. Context reconfirmation offers Continue and
Cancel. Settled failed, stale, partial, or no-response waves can prepare a
bounded retry using a new idempotency identity; completed outputs are not
silently duplicated.

On restart, Task Monki repairs cross-store links, queued cancellations,
terminal-before-curated-message crashes, lost queue linkage, and provably
undelivered starts. The global scheduler stays latched while a leased turn still
needs reconciliation. No recovery path replays a provider mutation without
proof that it was not delivered.

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
delivery, paging, drafts, and archive.

Changes to this lifecycle require focused storage/service/runtime tests plus:

```sh
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```
