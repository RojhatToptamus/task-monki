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
| Discourse conversation/runtime state | `src/core/discourse`, `src/core/storage/sqlite/SqliteDiscourseStore.ts` | Runtime state and curated conversation state remain separately attributable. |
| Application persistence composition | `src/core/storage/sqlite/ApplicationPersistence.ts` | One profile lease, SQLite connection, managed-file owner, and backup/recovery boundary. |
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

- Keep focused tests beside the production module they exercise. Bounded local
  filesystem or process use may remain focused when it keeps fast, isolated
  feedback. Name long-running resource-heavy, listener, process-lifecycle, or
  multi-service suites `*.integration.test.ts`, and executed end-to-end workflow
  wrappers `*.system.test.ts`.
- Use `src/testSupport` for typed fixtures that model shared domain records or a
  complete cross-service scenario. Avoid untyped object literals for durable
  records when a shared builder already exists.
- Use renderer model tests for state matrices and small SSR component tests for
  meaningful presentation seams. Use the mounted renderer test target for
  behavior that depends on state updates, focus, events, or effects. Use seeded
  UI and browser inspection for layout, responsive behavior, visual hierarchy,
  and theme appearance.
- Static style assertions load the ordered CSS import graph through
  `src/testSupport/rendererStyles.ts`; they must not inspect only the root
  import manifest.
- Name test files for behavior or responsibility. Historical phase numbers do
  not communicate the invariant being protected.

### Permanent coverage threshold

Every permanent test must identify the meaningful regression it prevents.
Good reasons include a product workflow, a durable data or API contract, a
security or authority boundary, accessibility behavior, a realistic failure or
recovery path, and a bug whose cause could plausibly return.

Do not add a test only because a change was requested or because coverage
decreased. Exact colors, spacing, widths, glyphs, CSS classes, DOM nesting,
incidental copy, private method calls, and duplicate projections are not stable
contracts by default. Cover them only when they carry a demonstrated product,
accessibility, protocol, or security requirement. Otherwise use visual review,
an existing generator/static check, or no permanent automated test.

Before adding coverage, ask in order:

1. Which user-visible behavior or system invariant could regress?
2. Which layer owns that behavior?
3. Does an existing test already protect it?
4. Can one broader scenario replace several narrow examples?
5. Is an automated test the right tool, or is a static, integration, system,
   seeded-browser, packaged, or manual check more truthful?

Tests should assert the public result or authoritative domain state. A test
that blocks safe refactoring without detecting a meaningful failure should be
rewritten, merged, or removed.

## Verification Commands

Choose the smallest relevant command while iterating, then run the broader
checks required by the changed boundary:

```sh
npm run test:focused
npm run test:integration
npm run test:system
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

- `test:focused` omits resource-backed integration and executed-system files
  for a fast local feedback loop.
- `test:integration` runs the slower resource-heavy, listener,
  process-lifecycle, and service-composition suites.
- `test:system` runs checked-in executed workflow wrappers.
- `npm test` remains the aggregate authority and includes all three lanes.

Do not add a heuristic affected-test selector. Explicit domain commands are
predictable for humans, local agents, and CI, and the full suite remains the
authority for cross-domain changes.

CI and release jobs run the architecture and mounted-renderer checks in
addition to the full Node suite so local agent guidance and delivery gates stay
aligned.
