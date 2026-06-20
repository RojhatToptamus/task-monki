# Task Manager Documentation Index

This directory is the persistent handoff point for future agents and humans working on the Task Manager app.

If you are picking up work in this repository, start here before changing code.

## Canonical reading order

1. `CODEX_TASK_BOARD_FEASIBILITY_REPORT.md`  
   Product, architecture, integration, and roadmap feasibility report.
2. `STATUS_MODEL_REPORT.md`  
   Canonical workflow/status model. This is the source of truth for separating human workflow from technical evidence.
3. `PHASE_1_STATUS.md`  
   Completed Phase 1 implementation status, verification evidence, and known limitations.
4. `docs/phases/PHASE_2_PLAN.md`  
   Current Phase 2 implementation plan.
5. `docs/phases/PHASE_2_STATUS.md`  
   Current Phase 2 status log. Update this after every Phase 2 implementation slice.

## Documentation policy

Every implementation phase must have:

- a phase plan before substantial implementation starts;
- a phase status document updated after each meaningful implementation slice;
- a clear “how to view/test” section;
- verification evidence, including exact commands where practical;
- known limitations and unresolved decisions.

Do not let important design intent live only in chat. If a future agent needs the information to avoid re-deciding or accidentally reversing architecture, persist it in this documentation set.

## Status model guardrail

The app must continue to preserve these separations:

- workflow phase is the human-facing board state;
- Codex/process/Git/tests/GitHub are technical evidence dimensions;
- readiness, health, warnings, and recommended actions are derived projections;
- Codex completion is not delivery truth;
- GitHub merge observation is the default delivery truth for PR-based tasks.

When changing code, check whether the change affects this separation. If it does, update the relevant docs and tests in the same work.

## Phase status document shape

Use this structure for every phase status update:

```text
# Phase N Status: <name>

Date:
Branch/commit:
Status:

## Implemented in this update

## How to view or test

## Verification evidence

## Known limitations

## Next slice
```

The status document should be useful without needing access to the original chat thread.
