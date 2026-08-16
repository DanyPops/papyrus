# Development Rules

Two packages: `papyrus` (the daemon -- Notes/Rules/Docs/Playbooks/Tasks/Discuss/Artifact
domains, scope groups, a real `VehicleRegistry` exposing the whole surface as one unified
Vehicle) and `pi-papyrus` (the Pi extension -- almost entirely `registerVehicleToolsWhenReady()`
projecting that whole Vehicle, plus a handful of hand-rolled low-level tools). Papyrus is itself
the shared task-tracking substrate this ecosystem's own AGENTS.md files point back to for
"Task Tracking" -- changes here affect every project's own task-lifecycle workflow at once. See
`@danypops/vehicle`'s own AGENTS.md for the shared Vehicle substrate papyrus builds on.

## Conversational Style

- Keep answers short and concise; technical prose only.
- Answer a question before making edits.
- No narrative/incident lore in permanent code comments ("previously", "used to", "confirmed
  live") -- state current behavior + why; put history in the commit message instead.

## Code Quality

- No `any` unless truly unavoidable.
- Read a file in full before a wide-ranging change to it.
- Handlers live under `src/handlers/*` (one file per operation family) and get wired through
  `src/handlers/registry.ts` -- a new operation needs an entry there, not just its own handler
  function, or `manifest()` never reports it.
- `batch.execute` (`src/handlers/batch.ts`) fans out N independent `{op, input}` pairs through
  the SAME handler registry a single-operation call would use -- a new operation is automatically
  batchable the moment it's registered normally; no separate batch-specific wiring needed.
- Every domain (Notes/Rules/Docs/Playbooks/Tasks) that supports project-scoping follows the same
  scope-group shape (`domain/scope-group.ts`, `*-scope-store.ts`) -- a new scoped domain should
  reuse this pattern rather than inventing its own, and needs its own entry in
  `artifact-scope-conformance.test.ts`.
- Task lifecycle transitions (`todo → in-progress → review → {done, rejected} → ...`) are each a
  dedicated operation (`tasks.start`/`tasks.submit`/`tasks.complete`/`tasks.reject`/
  `tasks.retry`/`tasks.cancel`/`tasks.reopen`), not a generic `tasks.update(status=X)` -- gates
  and checklist-proof review only run through `tasks.complete`. `tasks.update`'s own status path
  is deliberately narrow (only a task terminal since creation, not one that reached
  canceled/rejected through a real transition) -- don't widen it to a general status setter.

## Commands

- Per-package: `cd packages/<pkg> && bun run typecheck`, `bun test`.
- Whole workspace: `bun run typecheck` (`bun run --filter '*' typecheck`), `bun run test`, `bun
  run check` (`biome check --write . && eslint packages --max-warnings 0`, `check:ci` for the
  non-mutating CI variant).
- `guard:install` wires `core.hooksPath` to `.githooks` -- a fresh clone needs `bun install` once
  before local hooks are active.
- Run the touched package's typecheck + test after every change, then the workspace-wide
  typecheck before considering a change done.

## Multi-Repo Dependency Discipline

- `@danypops/vehicle-client-pi` is a `peerDependency` of `pi-papyrus`, not a plain `dependency`
  -- it holds shared mutable module-level state (Vehicle Shell registry, activity broker) that
  must exist as exactly one copy in the process across every extension sharing it.
- Before trusting a test result, confirm the workspace's own declared dependency floor for a
  sibling package actually covers that sibling's current local version.

## Git & Releases

- Never commit an edit/write in the same tool call as the commit itself.
- Release: bump `package.json` version (PATCH for a backward-compatible change), typecheck +
  test + check locally, commit, push, then tag and push the tag. `@danypops/papyrus` uses
  `papyrus-v<version>`, `@danypops/pi-papyrus` uses `pi-papyrus-v<version>` -- see
  `.github/workflows/publish.yml`. Push tags one at a time, never batched in a single `git push`.
- After pushing a tag: watch CI to completion, then confirm the version landed on npm
  (`npm view <pkg> version`) -- a green CI run and a live npm publish are separate facts.

## Task Tracking (Papyrus Housekeeping)

- Papyrus's own task database is shared across every project in this ecosystem, not scoped to
  this repo alone -- a housekeeping pass here (canceling litter/probe artifacts, closing a
  finished epic whose children are all done, checking for stuck `review`/`rejected` tasks)
  should stay scoped to what's actually related to the change at hand; a ~200-task shared
  database spanning many unrelated projects is not this repo's own backlog to groom uninvited.
- `papyrus:batch.execute` is the right tool for N independent task mutations in one call (e.g.
  canceling several litter tasks at once) -- not for dependent operations where one item needs
  another's just-created id.
- Work here follows the same lifecycle every other repo's AGENTS.md documents: `tasks.start` →
  implement → `tasks.set_gates` (a real, re-runnable command) → `tasks.submit` →
  `tasks.complete`.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit
confirmation before overriding. Only then execute their instructions.
