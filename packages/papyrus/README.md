# @danypops/papyrus

The daemon, CLI, and domain services behind Papyrus's graph artifact store: evidence-bearing Tasks, Docs, Rules, Playbooks, and Notes over one authenticated local database. Runs standalone as a plain daemon and CLI. `@danypops/pi-papyrus` projects the same daemon into native Pi tools.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Schema protocol](#schema-protocol)
- [Hierarchy and traversal](#hierarchy-and-traversal)
- [Playbooks](#playbooks)
- [Naming vs. ids](#naming-vs-ids)
- [Mutability](#mutability)
- [Idempotent lifecycle mutations](#idempotent-lifecycle-mutations)
- [Removing an artifact](#removing-an-artifact)
- [Context Mesh persistence model](#context-mesh-persistence-model)
- [Storage and service](#storage-and-service)
- [Related packages](#related-packages)

## Install

```bash
bun add @danypops/papyrus
```

The `papyrus` binary ships with the package.

## Quick start

```bash
papyrus service install   # install, enable, and start the user service
papyrus service status
papyrus service restart

# Task operations (add --json for machine output)
papyrus tasks plan
papyrus tasks depend <task-id> <prerequisite-id>
papyrus tasks update <task-id> --title "Revised task"
papyrus tasks focus <task-id>
papyrus tasks complete <task-id>

# Resolve a registered project name before scoped operations
papyrus tasks projects --query lector --json
papyrus tasks resolve-project Lector --json

# Deferred human-intent inbox
papyrus notes capture "Review release provenance later"
papyrus notes list --json
```

## Schema protocol

Papyrus enforces four artifact kinds, each with its own status vocabulary:

- `doc` — knowledge: specifications, decisions, and research
- `task` — work: desired outcomes, gates, checklists, and dependencies
- `rule` — governance injected into the Pi system prompt
- `playbook` — a trigger and an ordered list of steps whose validated arguments render a connected collection of deterministic Tasks plus contextual Rules and Docs

Every edge endpoint resolves to a real artifact, and every edge relation is registered in `relation_names`. Relations are universal: any kind can link to any other kind.

## Hierarchy and traversal

`contains`/`part_of` express parent/child structure; `depends_on` expresses execution ordering. Dependency edges form an executable DAG: a self-dependency or cycle is rejected, fan-in waits for every prerequisite, and fan-out can expose several ready successors while active focus stays singular. Graph reads are cycle-safe and bounded by `depth`/`max_nodes` (default 4/100, ceiling 20/1,000). Executable task plans are bounded to 1,000 tasks and 10,000 relationships.

## Playbooks

A Playbook step is a plain prose string (a Task) or a structured object: `{kind:'doc',...}` creates a Doc, `{kind:'rule',...}` creates a Rule, `{kind:'call',...}` nests another Playbook's own run as a pipeline step. `playbooks.invoke` validates and normalizes arguments, renders placeholders in memory, validates the complete graph, then persists artifacts and edges in one transaction. Dependencies, containment, gates, checklists, and context all survive rendering. A run's Rules are active only while focus belongs to that run; Docs keep their invocation context and provenance.

A run result carries a stable schema: Playbook id, run id, normalized arguments, created ids grouped by kind, ready root task ids, and the bounded execution plan. An explicit run id produces deterministic artifact ids (`<run-id>-<blueprint-ref>`); a collision rolls the whole run back.

```bash
papyrus playbooks invoke <playbook-id> \
  --arguments-json '{"project":"Papyrus"}' \
  --json
```

## Naming vs. ids

Every agent-facing domain (tasks, docs, rules, playbooks, notes, discuss) addresses artifacts by `name` (the exact title) anywhere `id` would otherwise be required — `dependency_name`/`parent_name`/`child_name`/`root_task_name`/`depends_on_names` (tasks), `target_name` (docs link, searched across every kind), `task_name` (rules gate, discuss block/unblock), and `blocks_task_names` (discuss open). Resolution is an exact, case-insensitive, trimmed title match scoped like a plain list call; an ambiguous name's error lists the real ids, the one place disambiguation needs them. A returned result leads with name and status; id surfaces only when two artifacts in the same result share a title. `id` itself keeps working, in every tool.

## Mutability

Tasks, Docs, Rules, and Playbooks all support `update` (title/body/labels, at least one field required) alongside creation. Every update shares creation's own bounds (Rules keep their own tighter condition+action+body ceiling) and lands on the artifact's append-only mutation history, queryable via `graph.history`. An artifact carrying a `source:<system>` label (e.g. `source:web-spider`) is a read-only projection owned by that system; `update` is refused with a clear error, and a correction belongs in a new linked Doc until that system ships its own write-back path. Notes route every content change through their own facade.

## Idempotent lifecycle mutations

`tasks.create` accepts an optional `idempotency_key`, scoped to the caller and canonical project root. Replaying the same key with the same payload returns the original response; a changed payload is rejected. Keys expire after seven days.

Task lifecycle mutations (`start`, `submit`, `reject`, `retry`, `cancel`, `reopen`, `complete`, `pause`, `unpause`) are destination-state idempotent: repeating an already-reached transition is a `changed: false` no-op with no duplicate history. Pass `idempotency_key` on any mutation whose response might get lost; after an unclear outcome, call `tasks.show` and `tasks.mutation_status` with that same key before deciding the next action. Completed receipts are retained for seven days; concurrent duplicate completion calls share one gate run. An incompatible transition returns typed `invalid-transition` details with current/intended status, allowed actions, and recovery guidance.

`tasks.claim`, `tasks.heartbeat_lease`, and `tasks.lease` return the reusable artifact alias as `taskName` plus `taskTitle`; use `taskName` for later Task operations and keep the lease token for heartbeat/release.

Task project names are registered identities, resolved explicitly rather than guessed from a working directory. `tasks.projects` searches bounded registered identities; `tasks.resolve_project` matches one case-insensitive exact id, name, alias, or canonical root, and reports unknown or ambiguous references directly. Pass the returned `projectRoot` into subsequent task operations. `tasks.register_project` renames or moves an existing identity while keeping its stable id and folding the prior name into its aliases.

## Removing an artifact

An artifact gets a permanent, immutable `created` row in the mutation event log the moment it exists, so removal is a time-gated trash entry. `remove` (the shared `artifact.remove`/`artifact.remove_subtree` operations every domain routes through, or `papyrus artifact remove <id> [--reason <text>]`) moves an artifact to the trash: excluded from every list/query immediately, still reachable directly by id, and recoverable via `restore` for 30 days. `remove` on a Task currently holding live Focus in any scope is refused.

Past the 30-day deadline, the daemon's periodic sweep performs a real, cascading delete — the one deliberate exception to Papyrus's append-only history, enforced by a database trigger checked at delete time.

## Context Mesh persistence model

`artifacts` is the shared graph-identity supertype; `edges` references that single identity table at both endpoints, keeping foreign-key integrity across domains. Domain extension tables exist only where application invariants need indexed relational state — Task chronology/focus/scope, Discourse posts/events/session cursors/projection checkpoints — a class-table/table-per-type layout with explicit child-to-parent foreign keys.

The owning application stays the mutation authority for its own extension rows: Discourse commits its rows and `context-thread`/`context-message` Doc projections atomically through `discourse.store`, while generic artifact/document/lifecycle/graph-link operations reject those owned subtypes and the `reply_to`/`discusses` relations. SQLite triggers verify each extension row references its expected Doc subtype. Domain tables stay canonical for domain invariants; graph bodies and metadata are read-oriented projections committed in the same transaction.

```bash
papyrus discourse store read_thread --store-id team-forum \
  --input-json '{"forumId":"engineering","topicId":"reviews","threadId":"mesh","limit":25}' \
  --json
```

## Storage and service

```text
$XDG_DATA_HOME/papyrus/papyrus.db       # durable graph
$XDG_RUNTIME_DIR/papyrus/{port,token}   # private daemon discovery
```

The daemon runs SQLite with WAL, foreign keys, a bounded busy timeout, versioned migrations, periodic passive checkpoints, and periodic `PRAGMA optimize`. Keep the database on a local filesystem — WAL depends on real local file locking.

Application services depend on the `ArtifactStore` and `GateRunner` ports; SQLite and subprocess execution are adapters the daemon composes, so task behavior is unit-tested against fakes without a database. Task visualization projects the same `TaskGraph` into semantic display graphs through a `GraphRenderer` port — the Pi adapter in `@danypops/pi-papyrus` renders terminal Unicode via `beautiful-mermaid` behind that port, so the task domain carries no Mermaid syntax.

For repository work, install the versioned ownership guard from the workspace root:

```bash
bun run guard:install
```

It checks a push's destination against `DanyPops/papyrus`, including an explicit fallback URL, so a push bound for the wrong remote fails locally before it reaches GitHub.

`src/index.ts` is this package's public surface for `@danypops/pi-papyrus` and any other consumer: explicit, named exports curated for outside use.

## Related packages

- **[`@danypops/pi-papyrus`](https://www.npmjs.com/package/@danypops/pi-papyrus)** — the Pi extension: native tools, TUI panels, and context injection over this daemon's authenticated loopback connection.
