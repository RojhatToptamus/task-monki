# Module Boundaries And Verification

This document is the maintainer map for deciding where Task Monki code belongs.
It describes the current dependency direction and the checks that protect it;
it is not a proposal for a generic layered framework.

## Dependency Direction

Production dependencies point inward toward durable contracts and domain
behavior:

```text
Electron host ─┐
Dev HTTP host ─┼─> Core ─> Shared contracts
Renderer UI ───┴─> Renderer model ─> Shared contracts
        └────────> Renderer API ───> Shared contracts
```

- `src/shared` contains durable contracts and cross-process value types. It
  cannot import application, provider, storage, host, or renderer code.
- `src/core` owns domain behavior, persistence, projections, orchestration,
  provider adapters, and local evidence. It can import `src/shared`, but not
  renderer or host modules.
- `src/renderer/model` contains pure selectors, formatting, and view models. It
  cannot import React UI, renderer transport adapters, or core services.
- `src/renderer/api` implements the browser transport. It cannot import UI or
  view-model code.
- `src/renderer/ui` owns React presentation and interactions. It may use the
  renderer model and API, but it cannot bypass the Task Manager API to reach
  core, Electron, or development hosts.
- `src/electron` and `src/dev` are composition and trust-boundary hosts. They
  may assemble core services while preserving their distinct IPC and HTTP
  validation rules.
- `src/testSupport` is test-only. Production modules must never import it.

`npm run check:architecture` enforces these directions and rejects file-level
cycles in hand-written production source. Generated Codex protocol bindings are
excluded because their layout is owned by the pinned generator; the handwritten
codec and adapter boundary remains checked. Provider implementations are also
kept independent: Codex, ACP, and OpenCode adapters cannot import one another.

## Responsibility Map

| Concern | Owner | Notes |
| --- | --- | --- |
| Durable task, run, evidence, and workflow truth | `src/core` | Provider output is telemetry until independently verified. |
| Provider process/session/turn protocol | `src/core/agent/<provider>` | Keep provider-specific rules local; do not introduce a common adapter base merely to align file shapes. |
| Discourse conversation/runtime state | `src/core/discourse`, `src/core/storage/FileDiscourseStore.ts` | Runtime state and curated conversation state remain separately attributable. |
| Discourse runtime composition | `src/core/app/DiscourseRuntimeHost.ts` | Owns scheduler, recovery, scoped routing, and shutdown without moving durable conversation truth out of its store. |
| Provider composition | `src/core/app/AgentRuntimeComposition.ts` | Wires built-in adapters and scoped routers; provider protocol behavior stays in each adapter. |
| Preview validation and execution | `src/core/preview` | YAML normalization remains separate from `PreviewExecutionAuthority`; preserve bounded lifecycle ownership and explicit private-input handling. |
| Cross-process contracts | `src/shared` | Treat stored and transport shapes as durable. |
| Derived UI state | `src/renderer/model` | Pure and directly testable; never a second workflow source of truth. |
| React composition and local interaction state | `src/renderer/ui` | Split by a meaningful user-facing feature or lifecycle owner, not by element count. |
| Renderer styling | `src/renderer/styles.css`, `src/renderer/styles/*` | The root file defines the import order. Feature files preserve that cascade; move selectors with their responsive and accessibility rules intact. |
| Electron IPC and window lifecycle | `src/electron` | Retain sender validation and bounded attachment handling. |
| Browser development HTTP/SSE host | `src/dev` | Retain origin, token, request-size, timeout, and concurrency gates. |

## Test Placement

- Keep focused tests beside the production module they exercise.
- Use `src/testSupport` for typed fixtures that model shared domain records or a
  complete cross-service scenario. Avoid untyped object literals for durable
  records when a shared builder already exists.
- Use renderer model tests for state matrices and SSR component tests for stable
  markup. Use the mounted renderer test target for behavior that depends on
  state updates, focus, events, or effects.
- Static style assertions load the ordered CSS import graph through
  `src/testSupport/rendererStyles.ts`; they must not inspect only the root
  import manifest.
- Name test files for behavior or responsibility. Historical phase numbers do
  not communicate the invariant being protected.

## Verification Commands

Choose the smallest relevant command while iterating, then run the broader
checks required by the changed boundary:

```sh
npm run check:architecture
npm run test:renderer
npm run test:renderer:dom
npm run test:core
npm run test:storage
npm run test:agent
npm run test:transport
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```

Do not add a heuristic affected-test selector. Explicit domain commands are
predictable for humans, local agents, and CI, and the full suite remains the
authority for cross-domain changes.

CI and release jobs run the architecture and mounted-renderer checks in
addition to the full Node suite so local agent guidance and delivery gates stay
aligned.
