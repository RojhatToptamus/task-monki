# Discourse lifecycle

Discourse is a continuous conversation outside the task workflow. It offers
**Notes** and **Chat**. Notes saves writing without starting an agent. Chat
normally asks one main agent.

## Main agent and optional peer

The composer addresses the main agent by default. A user can address another
available participant with a mention or reply to that participant's message.
The settings sidebar uses the shared provider, model, and reasoning controls.
Adding a peer makes it available; it does not start a call.

**Ask peer** prepares a message about one selected answer. The user can edit the
question before sending. The peer sees the selected answer, the user's request,
relevant public conversation, and selected context. It addresses useful
corrections, objections, assumptions, or alternatives directly to the author.
It need not produce a second full answer.

The peer may find no issue, agree, remain uncertain, or abstain. Its output
contains a visible Markdown message and a boolean `requestAuthorResponse`.
That boolean requests work; it is not a correctness or review verdict.

If the peer requests a substantive response, the original author responds once.
The author receives the peer's exact message and the same context, including its
own selected answer. It may revise, defend, clarify, or remain uncertain.
The original answer is not overwritten. There is no judge, vote, automatic
comparison, or consensus claim.

Each explicit peer request allows at most two jobs: one peer and one author.
There is no automatic third turn. A further exchange requires a user request
with a specific question, new evidence, or an unanswered objection.

## Conversation and stopping

A completed runtime turn means the agent stopped generating. It does not mean
the user's decision is resolved or the answer is correct. Normal completion
needs no extra status card.

- For a complete answer, the agent gives the conclusion and relevant limits.
- For a necessary preference or missing user fact, it asks the specific question.
  A reply targets that message; no comparison sequence restarts.
- For missing factual evidence, it names what is needed and the check that could
  resolve it. Confidence or agreement does not replace evidence.
- Compatible recommendations under different preferences are not factual
  disagreement. Unresolved incompatible claims remain attributed in the text.
- A peer that finds no useful author action ends the exchange without a summary.
- The response allowance is 20 minutes from its persisted start time. The
  deadline and job-count checks prevent further dispatch after exhaustion.

While an agent runs, the composer keeps the user's draft editable and offers
Stop. Stop must finish before another Chat message can be sent from the UI.
Completed messages remain visible. Keyboard submission cannot bypass this
boundary. Existing queued requests remain recoverable through their saved
intent; they do not gain conversation messages produced after acceptance.

## Context and settings

Each job uses a fresh provider session reconstructed from the public transcript.
There is no reliance on hidden provider memory. Recent history is bounded to
80 messages, 48,000 estimated tokens, and 256 KiB. Explicit reply and selected
source messages take priority over optional recent history. A job is rejected
when its required context exceeds the applicable model or prompt budget.

Pinned task and repository references use the existing context owner. Each
response saves its resolved source context. Native permission identity belongs
to each provider session, not to another agent's session.

Source freshness is checked before dispatch, before accepting output, and
before handing a peer message to its author. An agent's own published response
does not invalidate the selected source context. Real source changes still
block continuation. Changed-context output remains visible as historical
output, not current evidence.

The existing app settings store owns last-used Discourse defaults. Drafts own
unsent text, recipients, and selected settings. Executed jobs retain their exact
participant revision, model, reasoning setting, and runtime identity.
Unavailable saved choices remain visible and block dispatch. They do not
silently fall back to another model.

## Runtime and recovery

Chat reuses accepted sends, response waves, jobs, scoped runtime sessions,
scheduler admission, and terminal reconciliation. It adds no parallel workflow.

A single-agent Chat wave contains one primary assignment and one answer job.
A peer check contains a primary and reviewer assignment. Its first answer job
belongs to the peer; its optional second answer job belongs to the author.
The existing `DISCOURSE_ANSWER` runtime purpose handles both.

The accepted user message and execution intent are saved atomically before
provider work. Repeated client IDs replay only an identical request.
Recovery reconstructs a missing author handoff from the completed peer result.
It must not duplicate either job or resend an ambiguously delivered provider turn.

Cancellation prevents new downstream work. An already completed answer wins a
cancellation race and remains in history. Uncertain delivery requires recovery
or an explicit stop, not a silent retry. Invalid peer output is retained in the
runtime artifact and ends that request; no repair call is made.

The UI distinguishes changed context, interrupted delivery, stopping, failure,
and time-limit exhaustion. Recovery actions prepare an explicit new question or
use the existing safe context-confirmation path. They do not replay old modes.

## History and storage compatibility

Database migration 5 changes mutable conversation and app-setting mode defaults
to Chat. It does not change messages, waves, jobs, model settings, or unsent
drafts. Old draft modes map to Chat when shown in the composer; their text and
saved selections remain recoverable.

Earlier Direct, Panel, Team, and ABC records remain readable. Structured
comparisons and responses have a read-only historical renderer. Old review
notes remain available beside their original response. New sends reject retired
modes. Startup cancels unplanned retired-mode intents and stops unfinished
retired work without deleting its messages or inventing completion.

Legacy result parsing remains only to reconcile output already delivered by an
earlier runtime. No new old-mode prompt or downstream round is generated.

## Authority and access

Discourse remains advice. It does not own Task Monki review, task phases,
acceptance, Git status, tests, or GitHub delivery. Task Monki's detached
agent-review workflow remains the only review authority.

The existing read-only runtime boundary remains: no repository writes,
network access, apps, MCP, dynamic tools, or approval escalation. Provider
claims are not verified evidence. Per-job and per-response output limits remain
in force. Estimated input/output reservations are not a provider billing cap.
