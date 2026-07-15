import type {
  AgentExecutionSettings,
  GitSnapshotRecord,
  RunRecord,
  Task,
  WorktreeRecord
} from './contracts';

export const TASK_MONKI_CONTEXT_LINE =
  'Task Monki is a local task board for running AI coding work in isolated Git worktrees.';

export const AGENT_REVIEW_DEVELOPER_INSTRUCTIONS = `You are performing a detached Task Monki review.

${TASK_MONKI_CONTEXT_LINE}

Review only the current diff. Do not modify files.

If the runtime supports interim messages, send brief user-facing progress messages beginning with "Progress:" after meaningful review milestones.
Examples: "Progress: Inspecting changed files for regressions." or "Progress: Preparing review findings."
Do not include shell commands, protocol details, raw logs, or full paths in progress messages.
Do not include these Progress lines in the final review output.

Return a concise human-readable review followed by exactly one fenced JSON block whose language is json.
The JSON block must match this schema:

{
  "schemaVersion": "codex-review/v1",
  "verdict": "PASSED" | "NEEDS_CHANGES" | "INCONCLUSIVE",
  "summary": "One short sentence explaining the review result.",
  "findings": [
    {
      "id": "stable-kebab-case-id",
      "severity": "BLOCKER" | "MAJOR" | "MINOR" | "NIT",
      "title": "Short finding title",
      "explanation": "Why this matters and how it can fail.",
      "path": "relative/path/to/file.ts",
      "line": 123,
      "endLine": 125,
      "recommendation": "Specific fix direction."
    }
  ]
}

Severity definitions:
- BLOCKER: likely correctness, data-loss, security, or crash issue that should block acceptance.
- MAJOR: meaningful behavioral regression, broken workflow, or high-risk maintainability issue.
- MINOR: limited issue that should be fixed but does not normally block local acceptance.
- NIT: small style, wording, or cleanup note.

Use verdict NEEDS_CHANGES when any BLOCKER or MAJOR finding exists.
Use verdict PASSED when there are no blocker or major findings.
Use verdict INCONCLUSIVE only when the diff cannot be reviewed confidently.
If there are no findings, return an empty findings array.`;

/** @deprecated Use the provider-neutral review contract. */
export const CODEX_REVIEW_DEVELOPER_INSTRUCTIONS =
  AGENT_REVIEW_DEVELOPER_INSTRUCTIONS;

export const TASK_MONKI_PROGRESS_CONTRACT = `Task Monki progress contract:
- For non-trivial implementation, follow-up, retry, or alternative work, maintain a concise provider plan as progress telemetry.
- If the runtime exposes a plan, todo, or update_plan mechanism, use it after a brief read-only discovery pass and keep it current.
- Use 3-6 high-level outcome steps. Do not create steps for routine operations such as searching files, opening files, or running a single command.
- Keep exactly one step in progress while actively working.
- Update the plan before the first meaningful edit, after completing a step, before verification, and when scope changes.
- Send brief progress notes after meaningful milestones: what changed, what is next, and blockers or risks if any.
- Task Monki derives routine read/search/edit/run activity from provider tool telemetry. Use Progress: messages only for meaningful milestones, blockers, risks, and transitions; do not narrate every file read, search, command, or protocol event.
- If no plan/progress mechanism is available, write short progress messages beginning with "Progress:" at the same milestones.
- Do not claim verification until commands, tests, or checks actually ran.
- For trivial or read-only turns, skip the plan and briefly say why.
- Do not treat provider plan progress as proof; Task Monki independently verifies Git, tests, reviews, and delivery.`;

export const TASK_MONKI_ENGINEERING_QUALITY_CONTRACT = `Task Monki engineering quality contract:
- Before editing, inspect the relevant code, tests, and nearby patterns. Understand the source of truth, existing invariants, and why the issue happens.
- For bugs, identify the failure mode before changing code: why it happens now, why it did not happen before, and what state, lifecycle, timing, dependency, or data change caused it.
- Prefer existing architecture, helpers, selectors, state transitions, components, and style patterns over one-off logic.
- Do not make the first solution a patch that merely hides the symptom or satisfies the current conversation. Fix the smallest underlying cause that preserves the existing design.
- Keep changes scoped to the requested behavior. Do not create new files, docs, abstractions, dependencies, comments, or UI patterns unless they are necessary for the fix.
- After implementing, simplify the change. Remove dead code, duplicated logic, temporary guards, unnecessary comments, and conversation-driven scaffolding.
- Add or update tests that exercise the actual behavior, edge case, or regression risk. Do not add tests that merely assert implementation details or exist only to produce a green result.
- Run relevant verification commands when practical. If verification cannot run, say exactly what was not verified and why.
- Do not claim tests, builds, checks, commits, pushes, reviews, or delivery succeeded unless you actually performed or observed them.
- In the final response, summarize what changed, why it fixes the underlying issue, and what was verified.`;

const RUN_CONTEXT_EXCERPT_LIMIT = 900;

export function buildInitialRunPrompt(input: {
  task: Task;
  worktree: WorktreeRecord;
  settings: AgentExecutionSettings;
  readOnlyMode: boolean;
}): string {
  return [
    TASK_MONKI_CONTEXT_LINE,
    '',
    `Authoritative Task Monki goal:\n${input.task.prompt}`,
    '',
    input.readOnlyMode
      ? 'Analyze this task in an isolated Git worktree without modifying files.'
      : 'You are implementing this task in an isolated Git worktree.',
    `Repository root: ${input.worktree.worktreePath}`,
    input.readOnlyMode
      ? 'Do not modify repository files.'
      : 'Only modify files inside this worktree.',
    'Do not commit, push, merge, close PRs, change remotes, or modify repository settings.',
    '',
    TASK_MONKI_ENGINEERING_QUALITY_CONTRACT,
    '',
    TASK_MONKI_PROGRESS_CONTRACT,
    '',
    'When finished, summarize the files changed and verification you performed.'
  ].join('\n');
}

export function buildContinuationPrompt(input: {
  task: Task;
  run: RunRecord;
  gitSnapshot: GitSnapshotRecord;
  instruction?: string;
  kind: 'continuation' | 'retry';
}): string {
  const instruction = input.instruction?.trim();
  return [
    TASK_MONKI_CONTEXT_LINE,
    '',
    `Authoritative Task Monki goal:\n${input.task.prompt}`,
    '',
    previousRunContext(input.run, `This is a ${input.kind} after run ${input.run.id}.`),
    `Current independent Git evidence: status=${input.gitSnapshot.status}, head=${input.gitSnapshot.headSha ?? 'unknown'}, dirtyFingerprint=${input.gitSnapshot.dirtyFingerprint}.`,
    instruction ? `Additional user instruction:\n${instruction}` : undefined,
    '',
    `Repository root: ${input.gitSnapshot.worktreePath}`,
    'Continue in the existing isolated task worktree.',
    'Only modify files inside this worktree.',
    'Do not commit, push, merge, close PRs, change remotes, or modify repository settings.',
    'Reinspect the current repository state instead of assuming the prior turn completed every step.',
    '',
    TASK_MONKI_ENGINEERING_QUALITY_CONTRACT,
    '',
    TASK_MONKI_PROGRESS_CONTRACT,
    '',
    'When finished, summarize the files changed and verification you performed.'
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

export function buildForkAlternativeTaskPrompt(input: {
  task: Task;
  run: RunRecord;
  worktree: WorktreeRecord;
  instruction?: string;
}): string {
  const instruction = input.instruction?.trim();
  return [
    TASK_MONKI_CONTEXT_LINE,
    '',
    'Alternative attempt for this Task Monki goal.',
    '',
    `Authoritative Task Monki goal:\n${input.task.prompt}`,
    '',
    `Source task: ${input.task.id}`,
    previousRunContext(input.run, `Source run: ${input.run.id}.`),
    `Source base: ${input.worktree.baseSha}`,
    '',
    'Start fresh from the source task base revision in this new isolated worktree.',
    'Do not assume files changed by the source attempt are present.',
    '',
    TASK_MONKI_ENGINEERING_QUALITY_CONTRACT,
    '',
    TASK_MONKI_PROGRESS_CONTRACT,
    '',
    instruction ? `Alternative direction:\n${instruction}` : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

export function buildSteerInstruction(input: {
  instruction: string;
  worktreePath?: string;
}): string {
  const instruction = input.instruction.trim();
  return [
    'Additional instruction for the active Task Monki turn:',
    instruction,
    '',
    'Preserve the authoritative task goal, current isolated worktree boundary, and existing Task Monki constraints.',
    input.worktreePath ? `Current task worktree: ${input.worktreePath}` : undefined,
    'Do not commit, push, merge, close PRs, change remotes, or modify repository settings.'
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

export function buildAgentReviewPrompt(input: {
  task: Task;
  worktree: WorktreeRecord;
  target: import('./agent').AgentReviewTarget;
}): string {
  const target = (() => {
    switch (input.target.type) {
      case 'UNCOMMITTED_CHANGES':
        return 'Review the current uncommitted changes in the worktree.';
      case 'BASE_BRANCH':
        return `Review the current worktree changes against base branch ${input.target.branch}.`;
      case 'COMMIT':
        return `Review commit ${input.target.sha}${input.target.title ? ` (${input.target.title})` : ''}.`;
      case 'CUSTOM':
        return `Review target instructions:\n${input.target.instructions}`;
    }
  })();
  return [
    AGENT_REVIEW_DEVELOPER_INSTRUCTIONS,
    '',
    `Authoritative Task Monki goal:\n${input.task.prompt}`,
    '',
    target,
    `Repository root: ${input.worktree.worktreePath}`,
    'Do not modify repository files. Do not commit, push, merge, or change repository settings.',
    'Reinspect the repository and Git state directly. Provider output is review telemetry; Task Monki verifies the diff independently.'
  ].join('\n');
}

export function buildPromptRefinementInstruction(input: string): string {
  return [
    'You are refining a software task prompt for the repository in your current working directory.',
    '',
    'Before writing the prompt, inspect the repository with read-only commands. Review the file tree, package/build configuration, relevant implementation files, tests, and documentation. Do not modify any file.',
    '',
    'Return JSON only, with exactly these string fields:',
    '{"titleSuggestion":"...","prompt":"..."}',
    '',
    'The prompt value must be implementation-ready and contain these Markdown headings:',
    '## Goal',
    '## Repository context',
    '## Constraints',
    '## Acceptance criteria',
    '## Verification',
    '',
    'Repository context must name concrete files, modules, symbols, scripts, or architectural boundaries you actually inspected. Do not invent repository facts. Keep the requested scope intact and make acceptance criteria objectively testable.',
    'Verification must name concrete commands discovered from repository docs, package scripts, or nearby test conventions when available. If no concrete command can be proven, say what verification remains unknown instead of inventing one.',
    '',
    'User request:',
    input
  ].join('\n');
}

export function buildPromptRefinementFallbackPrompt(input: {
  titleSuggestion: string;
  userRequest: string;
  repositoryContext: string;
}): string {
  return [
    `# Task: ${input.titleSuggestion}`,
    '',
    '## Goal',
    input.userRequest,
    '',
    '## Repository context',
    input.repositoryContext,
    '',
    '## Constraints',
    '- Work only inside the task worktree created by this app.',
    '- Keep the change scoped to the requested task.',
    '- Do not push, merge, close PRs, delete branches, or change repository settings.',
    '- Preserve existing architecture and status-model boundaries.',
    '',
    '## Acceptance criteria',
    '- Implement the requested behavior with the smallest coherent change.',
    '- Preserve existing tests unless a test update is required by the requested behavior.',
    '- Add focused tests only where they prove core behavior or prevent a likely regression.',
    '- Update relevant phase/status docs when the change affects the delivery plan.',
    '',
    '## Verification',
    '- Run relevant repository scripts named above when they match the change.',
    '- Report any verification that could not run and why.',
    '- Report what changed, what was verified, and any remaining limitations.',
    ''
  ].join('\n');
}

function previousRunContext(run: RunRecord, heading: string): string {
  const lines = [
    `${heading}`,
    `Previous run status: ${run.status}.`,
    run.recoveryState && run.recoveryState !== 'NONE'
      ? `Previous recovery state: ${run.recoveryState}.`
      : undefined,
    run.terminalReason
      ? `Previous terminal reason: ${compactExcerpt(run.terminalReason)}.`
      : undefined,
    run.finalMessage
      ? `Previous provider final summary excerpt (context only, not verified evidence): ${compactExcerpt(run.finalMessage)}`
      : undefined
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n');
}

function compactExcerpt(value: string): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (compacted.length <= RUN_CONTEXT_EXCERPT_LIMIT) {
    return compacted;
  }
  return `${compacted.slice(0, RUN_CONTEXT_EXCERPT_LIMIT - 3).trim()}...`;
}

export interface FailingChecksInvestigationPromptInput {
  prNumber?: number | null;
  prHeadSha?: string | null;
  prUrl?: string | null;
  headRefName?: string | null;
  baseRefName?: string | null;
  failingChecks: Array<{
    name: string;
    workflow?: string | null;
    state?: string | null;
    status?: string | null;
    event?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    link?: string | null;
  }>;
}

export function buildFailingChecksInvestigationPromptTemplate(
  input: FailingChecksInvestigationPromptInput
): string {
  const checkLines = input.failingChecks.length
    ? input.failingChecks.map(
        (check) =>
          `- ${check.name}${check.workflow ? ` (${check.workflow})` : ''}: ${[
            `status ${check.state ?? check.status}`,
            check.event ? `event ${check.event}` : undefined,
            check.startedAt ? `started ${check.startedAt}` : undefined,
            check.completedAt ? `completed ${check.completedAt}` : undefined,
            check.link ?? 'no link available'
          ]
            .filter((part): part is string => Boolean(part))
            .join(' | ')}`
      )
    : ['- Failing check details were not available from gh pr checks.'];
  return [
    `Investigate the failing GitHub checks for PR #${input.prNumber ?? 'unknown'} at head ${input.prHeadSha?.slice(0, 12) ?? 'unknown'}.`,
    input.prUrl ? `PR URL: ${input.prUrl}` : undefined,
    input.headRefName && input.baseRefName
      ? `Branch: ${input.headRefName} -> ${input.baseRefName}`
      : undefined,
    '',
    'Focus on these failing checks:',
    ...checkLines,
    '',
    'Inspect the current worktree, identify likely causes, make local fixes if needed, and summarize what changed. Do not push unless the user approves.'
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}
