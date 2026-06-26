# Codex Protocol And Coupling Notes

Date: 2026-06-25

This is the current protocol boundary note. Older phase-by-phase investigation
logs were removed because they repeated stale implementation status.

## Protocol baseline

- Generated stable TypeScript bindings come from Codex CLI `0.141.0`.
- Runtime compatibility constants live in
  `src/core/agent/codex/protocol/metadata.ts`.
- The generated protocol files are source inputs and should stay checked in.
- `npm run check:codex-protocol` verifies generated bindings match the expected
  installed runtime.

## Compatibility policy

- Reject Codex versions older than `CODEX_PROTOCOL_RUNTIME_VERSION`.
- Allow newer versions only in stable compatibility mode.
- Do not depend on experimental fields unless a feature has an explicit runtime
  allow-list and fallback.
- Unknown server requests should be routed to an explicit unsupported path,
  not silently accepted as generated request types.

## Coupling boundary

Task Monki should depend on a provider-neutral orchestration model:

- sessions;
- runs;
- interactions;
- artifacts;
- provider observations;
- verified local evidence.

Codex-specific details should stay in the Codex adapter, protocol codec,
materializer, and raw journal.

Do not spread Codex protocol terms into product workflow decisions unless the
term is part of a provider-neutral Task Monki concept. For example:

- Good: `RunRecord.mode === "REVIEW"` and `projection.codexReview.status`.
- Risky: UI decisions based directly on a raw `thread/status/changed` payload.

## Generated bindings

Generated files are intentionally committed because they are part of the
compiled adapter contract. This keeps CI, reviews, and local development from
depending on whatever Codex runtime happens to be installed.

When regenerating:

```sh
npm run generate:codex-protocol
npm run check:codex-protocol
npm test
```

Regeneration should be a focused change. Avoid mixing generated protocol churn
with product behavior changes.

## Provider observations

Provider observations are useful for debugging and UI context, but they do not
replace local evidence.

Examples:

- provider plan;
- provider goal mirror;
- model and reasoning settings observed by Codex;
- token usage;
- subagent hierarchy;
- raw item activity.

These should remain labeled as provider-reported or debug-level information
when shown near workflow decisions.

## Runtime edge cases

The app must handle:

- App Server process exit or loss;
- late protocol errors after terminal server states;
- provider turn ID retargeting;
- missing terminal events after interrupt;
- provider saying there is no active turn while Task Monki still has a running
  local review record.

These cases should end in an explicit local state: completed, failed,
interrupted, canceled, stale, or reconciled. They should not leave the UI stuck
in a permanent running state.
