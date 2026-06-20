# Phase 6 Status: Lightweight Repo-Aware Prompt Refinement

Date: 2026-06-20  
Branch/commit: Working tree; not committed  
Status: Implemented

## Implemented in this update

Refine Prompt now uses `gpt-5.4-mini` with low reasoning effort through the local Codex CLI.

The model invocation:

- runs in the repository selected in the task form;
- uses the read-only sandbox and approval policy `never`;
- uses an ephemeral Codex session;
- has a 90-second timeout and bounded output capture;
- cannot modify repository files through the configured sandbox;
- returns a structured title and implementation prompt.

The refinement instruction requires the model to inspect the repository before answering. It specifically directs the model to review:

- the repository file tree;
- package and build configuration;
- relevant implementation files;
- focused tests;
- relevant documentation and architecture boundaries.

The generated prompt must include:

- `Goal`;
- `Repository context`;
- `Constraints`;
- `Acceptance criteria`;
- `Verification`.

Repository context must name concrete files, modules, symbols, scripts, or architectural boundaries actually found during inspection.

If Codex is unavailable, authentication fails, the invocation times out, or the response is malformed, the feature returns the existing metadata-based deterministic prompt. The response identifies whether its source was `model` or `deterministic-fallback`.

No model change was made to implementation or review runs. Those are not lightweight steps and retain their existing execution configuration.

## How to view or test

### In the application

1. Open the Create Task form.
2. Select or enter a valid repository path.
3. Enter a short task request.
4. Click `Refine Prompt`.
5. Confirm the result contains concrete repository references and the five required sections.

The selected repository must be accessible to the app, and the local Codex CLI must be authenticated for model-backed refinement. If it is not, the form still receives the deterministic fallback.

### Focused automated test

```bash
npm test -- --run src/core/prompt/PromptRefinementService.test.ts
```

The focused tests verify:

- model output is used and repository-inspection instructions are present;
- model failure uses deterministic repository context;
- the command selects `gpt-5.4-mini`, low reasoning, ephemeral execution, and read-only access.

### Full verification

```bash
npm run typecheck
npm test
npm run build
```

## Verification evidence

Initial direct model smoke test:

```text
model: gpt-5.4-mini
reasoning effort: low
result: model-smoke-ok
elapsed time: 10.94 seconds
exit code: 0
```

Final local verification:

```text
typecheck: passed
tests: 14 files passed, 35 tests passed
build: passed
```

The post-implementation repository-aware live invocation was attempted but rejected before execution because the workspace model spend cap had been reached. It did not produce a model result. The command construction, repository-inspection instruction, structured-response validation, and fallback behavior are covered by focused tests.

## Known limitations

- Model-backed refinement depends on a working, authenticated local Codex CLI and network access.
- Workspace model spend limits can force the deterministic fallback even when the CLI is installed and authenticated.
- The deterministic fallback reads package metadata and README content but cannot provide the same depth as model repository inspection.
- Refine Prompt is intentionally synchronous from the form's perspective; a later phase could expose progress or cancellation if observed latency warrants it.

## Next slice

Use the same explicit model-and-reasoning configuration pattern only for future steps that are genuinely lightweight. Implementation and review agents should be configured separately based on their higher correctness requirements.
