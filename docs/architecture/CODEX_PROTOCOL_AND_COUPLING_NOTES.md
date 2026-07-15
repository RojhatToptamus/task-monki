# Codex Protocol And Coupling Notes

Date: 2026-07-11

This document defines the current Codex protocol boundary and compatibility
policy.

## Protocol baseline

- Generated stable TypeScript bindings come from Codex CLI `0.141.0`.
- Runtime compatibility constants live in
  `src/core/agent/codex/protocol/metadata.ts`.
- The generated protocol files are source inputs and should stay checked in.
- `npm run check:codex-protocol` verifies the committed generated bindings still
  hash to the pinned metadata value. In `--check` mode it does not execute the
  installed Codex runtime and does not prove local runtime compatibility.

## Compatibility policy

- Resolve a compatible Codex executable before starting App Server instead of
  blindly using the first `codex` on `PATH`.
- Reject a runtime only when it cannot launch the required App Server
  integration or lacks required JSON-RPC capabilities.
- Accept newer Codex runtimes by default when the required App Server
  capabilities work.
- Treat `CODEX_PROTOCOL_RUNTIME_VERSION` as the generated binding baseline, not
  a runtime minimum by itself.
- Do not depend on experimental fields unless a feature has an explicit runtime
  allow-list and fallback.
- Unknown server requests should be routed to an explicit unsupported path,
  not silently accepted as generated request types.

## Runtime probing

Task Monki probes candidate Codex executables in this order:

1. explicit app configuration;
2. `TASK_MONKI_CODEX_BIN`;
3. all `codex` entries discovered on `PATH`;
4. known bundled locations such as Codex Desktop and the OpenAI Codex VS Code
   extension.

The probe records `--version`, detects the supported stdio App Server launch
form from `codex app-server --help`, starts the candidate with a temporary
`CODEX_HOME`, initializes JSON-RPC, and verifies the methods Task Monki uses.
`CODEX_HOME` is admitted by the explicit
`task-monki/codex-environment@v1` contract rather than the portable child
environment, so other runtimes cannot inherit Codex state.
Automatic discovery picks a compatible runtime instead of failing on an older
incompatible candidate that appears earlier on `PATH`. Explicit configuration is
treated as intentional and must be compatible.
Resolution diagnostics are persisted with the selected App Server instance so
provider debug surfaces can show the selected executable, candidate versions,
rejected candidates, missing methods, and probe failures without presenting them
as normal workflow warnings.

## Coupling boundary

Task Monki should depend on a provider-neutral orchestration model:

- immutable task runtime identity and runtime-scoped provider IDs;
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

- Good: `RunRecord.mode === "REVIEW"` and the local review-gate projection
  (`projection.codexReview` retains its legacy schema-12 field name).
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
