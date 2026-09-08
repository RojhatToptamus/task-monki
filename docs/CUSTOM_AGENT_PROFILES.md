# Custom Agent Profiles

Profiles contain reusable working instructions for tasks and Designs.
Each profile has a name, description, and instructions.

## Create a profile

Open **Settings → Profiles** and select **New profile**.
Start with a blank profile or a Frontend, Testing, Security, or Protocol starter.
The library supports editing, duplication, and deletion.

Names must be unique without regard to letter case or surrounding spaces.
The library holds at most 32 profiles.
Names have an 80-character limit, descriptions have a 240-character limit, and instructions have a 16 KB UTF-8 limit.
Instruction whitespace is preserved.

## Select a profile

Use the **Profile** dropdown inside the new task or new Design composer.
The default is **None**.
The selected instructions are saved when the task or Design is created.
Library edits and deletion do not change that saved selection.

Task implementation, retries, and follow-ups receive the saved instructions.
Design creation and refinement turns receive the same saved instructions.
Forked tasks and duplicated Designs inherit the source's saved selection.

Profiles are not selected in task details, agent reviews, or Discourse.
Imported work and prompt refinement retain their existing behavior without profiles.

## Runtime and persistence

Repository rules, user requirements, and Task Monki execution contracts take precedence over profile guidance.
Design retains its permanent instructions, app-owned skills, tool grants, and managed-worktree boundary.
Profiles cannot grant tools, network access, permissions, or workflow authority.
References to skills do not install or enable them.
Provider claims remain separate from verified Git, test, and delivery evidence.

App settings own the reusable library; each task or Design owns its assigned copy.
Historical runs retain their exact assembled prompts in existing artifacts.
SQLite migration 3 upgrades settings schema 12 to 13 with an empty profile library and preserves the verified pre-upgrade backup.
Task and Design records use the optional `agentProfile` field in their existing payloads.
No additional table, profile version graph, or configuration lifecycle exists.

The API exposes `saveAgentProfile` and `deleteAgentProfile` through Electron and the authenticated development server.
Task and Design creation accept `agentProfileId`; core resolves the ID from the library.
Unknown IDs fail before creation.
An acknowledged creation retry returns its original result even after library edits or deletion.
