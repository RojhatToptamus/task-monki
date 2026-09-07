# Custom Agent Profiles

Custom agent profiles contain reusable working instructions for coding tasks, reviews, and Discourse responders.
Each profile has a name, a short description, and instructions.
Task Monki assigns profiles only through an explicit user selection.

## Create and assign a profile

1. Open **Settings → Profiles**.
2. Select **New profile**.
3. Start with a blank profile or a Frontend, Testing, Security, or Protocol starter.
4. Describe the working methods, checks, and outputs that the work needs.
5. Select **Save profile**.

The library supports editing, duplication, and deletion.
Names must be unique without regard to letter case or surrounding spaces.
The library holds at most 32 profiles.
Names have an 80-character limit, descriptions have a 240-character limit, and instructions have a 16 KB UTF-8 limit.
Task Monki preserves instruction whitespace.

## Selection and scope

| Surface | Behavior |
| --- | --- |
| New task | The Agent profile selector assigns a copy of the selected instructions. The default is None. |
| Task details | The selector shows the saved copy and its instructions. A new selection replaces that copy for future runs. |
| Implementation | Initial runs, retries, and follow-ups receive the assigned instructions. This includes follow-ups from review findings and failed checks. |
| Active run | The task profile cannot change during active agent work. Steering supplies additional direction within the current run. |
| Forked alternative | The new task inherits the source task's saved profile, even after library edits or deletion. |
| Agent review | The Review profile selector chooses guidance independently. The default is None. Review permissions remain read-only. |
| Discourse | Each Lead, Skeptic, or Verifier responder has an independent profile selector beside its runtime settings. |

A library edit affects future selections. It does not change assigned copies.
An updated library entry appears as **updated** beside the saved selection.
An explicit selection applies the updated instructions.
Deleting a library entry preserves existing task and Discourse assignments.
Selecting **None** removes profile guidance from future work.
Earlier conversation messages remain in the provider session as context.
Each new implementation prompt explicitly replaces earlier profile guidance.

Discourse preserves the selected instructions in its existing participant revision record.
Every accepted wave references those records, including later Team review and correction phases.
Changing a responder profile applies to the next accepted message and subsequent messages.
It does not change queued jobs from an earlier wave.
The Discourse role and output contracts remain authoritative.
Profile text counts toward the existing prompt budget.

Solution Trials and Workstreams are not implemented workflows in this repository.
They have no separate profile storage or assignment API.
Managed Design canvases retain their existing specialized prompt and skill flow.
Profiles do not affect prompt refinement, repository settings, or native subagent selection.

## Authority and runtime compatibility

Repository instructions, task requirements, current user direction, and Task Monki execution contracts take precedence over profile guidance.
Profiles cannot grant tools, permissions, network access, delegation, or workflow authority.
They cannot mark tests, Git changes, delivery, or acceptance as verified.
Existing runtime policy and independent Task Monki evidence checks retain those responsibilities.

A profile can refer to an available skill by name.
The runtime retains responsibility for skill discovery and execution.
A reference does not install a skill, enable an MCP server, or override a permission rule.
Native agent definitions can contain runtime-specific settings and capabilities.
Task Monki does not import those definitions or translate their tool lists into grants.

Implementation uses the existing provider prompt path, including ACP text prompts.
Native Codex reviews receive the assembled review prompt through the detached review thread's developer instructions.
Other supported review paths receive that prompt through their existing turn interface.
Runtime and model support remain subject to the existing capability checks.

## Ownership and persistence

The app settings library owns reusable profile entries.
The task owns its assigned copy.
Historical runs retain their exact assembled instructions in the existing prompt artifact.
Discourse jobs reference existing participant revisions and retain their dispatched prompts in runtime artifacts.
Library edits never rewrite these historical records.
No profile revision graph, hash, manifest, or separate lifecycle exists.

App settings schema 12 adds the profile library.
The settings store migrates schemas 10 and 11 with an empty library and preserves existing preferences.
Task and Discourse records use optional profile fields, so existing records remain valid without rewriting them.
Their loaders validate profile fields when present.
Settings writes and task assignment use the existing serialized, atomic storage operations.

The shared API exposes `saveAgentProfile`, `deleteAgentProfile`, and `setTaskAgentProfile` through Electron and the authenticated development server.
Task creation and review requests accept `agentProfileId`.
Core resolves that ID from the library. It does not accept a caller-supplied task profile copy.
Discourse selection uses `customProfileId`.
Omission retains the saved copy, `null` clears it, and an ID applies the current library entry.
An unavailable ID produces an error before work starts.
An acknowledged creation retry retains its original result after library edits or deletion.
