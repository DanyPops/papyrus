# @danypops/papyrus

The daemon, CLI, and domain services behind Papyrus's graph artifact store. Installable and runnable standalone, with no Pi dependency — the Pi extension lives in the sibling `@danypops/pi-papyrus` package.

## Storage and service

```text
$XDG_DATA_HOME/papyrus/papyrus.db       # durable graph
$XDG_RUNTIME_DIR/papyrus/{port,token}   # private daemon discovery
```

```bash
bun src/cli.ts service install   # install, enable, and start user service
bun src/cli.ts service status
bun src/cli.ts service restart

# Authenticated daemon-backed Task operations (add --json for machine output)
papyrus tasks plan
papyrus tasks depend <task-id> <prerequisite-id>
papyrus tasks update <task-id> --title "Revised task"
papyrus tasks focus <task-id>
papyrus tasks pause
papyrus tasks unpause
papyrus tasks complete <task-id>

# Resolve a human project name safely before scoped operations
papyrus tasks projects --query lector --json
papyrus tasks resolve-project Lector --json

# Deferred human-intent inbox
papyrus notes capture "Review release provenance later"
papyrus notes list --json
```

For repository work, install the versioned ownership guard once (from the workspace root):

```bash
bun run guard:install
```

It blocks every Papyrus push whose destination is not `DanyPops/papyrus`, including explicit fallback URLs that bypass `origin`.

The daemon uses WAL, foreign keys, a bounded busy timeout, versioned migrations, periodic passive checkpoints, and periodic `PRAGMA optimize`. Keep the database on a local filesystem; SQLite WAL does not support network filesystems.

Task project names are explicit registrations, never ambient-directory guesses. `tasks.projects` searches bounded registered identities; `tasks.resolve_project` requires one case-insensitive exact id, name, alias, or canonical root and fails on unknown or ambiguous references. Pass its returned `projectRoot` as `project_root` to subsequent task operations. `tasks.register_project` can rename or move an existing identity while preserving its stable id and prior name as an alias.

`tasks.create` accepts an optional `idempotency_key`. Replays with the same caller, canonical project root, key, and payload return the original response without another mutation; conflicting payload reuse is rejected. Keys are retained for seven days, isolated across callers and projects, and then expire. Retry only when reusing the exact key and payload; an unkeyed create remains unsafe to replay after an ambiguous transport failure.

Task lifecycle mutations (`start`, `submit`, `reject`, `retry`, `cancel`, `reopen`, `complete`, `pause`, and `unpause`) are destination-state idempotent: repeating an already-achieved transition is a successful `changed: false` no-op and creates no duplicate history. Supply an `idempotency_key` for every mutation whose response could be lost. After an unknown outcome, call `tasks.show` and `tasks.mutation_status` with the original key, then replay only that exact operation/key if needed—never invent a new key from stale state. Completed receipts are retained for seven days; concurrent duplicate completion calls share one gate run. A genuinely incompatible transition returns typed `invalid-transition` details with current/intended status, allowed actions, and recovery guidance.

Task lease responses are name-first: `tasks.claim`, `tasks.heartbeat_lease`, and `tasks.lease` return the reusable artifact alias as `taskName` plus `taskTitle`, not the backend UUID. Use `taskName` for later Task operations; retain the lease token for heartbeat or release.

### Context Mesh persistence model

`artifacts` is the shared graph-identity supertype, not a second copy of every application's database. `edges` references that single identity table at both endpoints, preserving foreign-key integrity for cross-domain links. Domain extension tables exist only where application invariants require indexed relational state: Task chronology/focus/scope and Discourse posts/events/session cursors/projection checkpoints. This is a class-table/table-per-type variant with explicit child-to-parent foreign keys; Papyrus does not use SQLite table inheritance or orphan-prone `(target_type, target_id)` links.

The owning application remains the mutation authority. Discourse commits its extension rows and `context-thread`/`context-message` Doc projections atomically through `discourse.store`; generic artifact, document, lifecycle, and graph-link operations reject those owned subtypes and the `reply_to`/`discusses` relations. SQLite triggers additionally verify that each extension row references the expected Doc subtype. Domain tables are canonical for domain invariants; graph bodies and metadata are read-oriented projections committed in the same transaction.

The authenticated CLI exposes the same operation for diagnostics and adapter parity:

```bash
papyrus discourse store read_thread --store-id team-forum \
  --input-json '{"forumId":"engineering","topicId":"reviews","threadId":"mesh","limit":25}' \
  --json
```

## Schema protocol (enforceable)

Papyrus enforces four artifact kinds:

- `doc` — knowledge: specifications, decisions, and research
- `task` — work: desired outcomes, gates, checklists, and dependencies
- `rule` — governance injected into the Pi system prompt
- `playbook` — a trigger and an ordered list of steps whose validated arguments render a connected collection of deterministic Tasks plus contextual Rules and Docs

Each kind has an enforced status vocabulary. Every edge endpoint must exist, and every edge relation must be registered in `relation_names`. Relations are universal: any artifact kind can link to any other kind.

### Hierarchy and traversal

Use `contains` and `part_of` for explicit parent/child structure; use `depends_on` for execution ordering. Dependency edges form an executable DAG: self-dependencies and cycles are rejected, fan-in waits for every prerequisite, and fan-out can expose several ready successors while active focus remains singular. Graph reads are cycle-safe and bounded by `depth` and `max_nodes` (defaults: depth 4, 100 nodes; hard ceilings: depth 20, 1,000 nodes). Executable task plans are additionally bounded to 1,000 tasks and 10,000 relationships.

### Playbooks

A Playbook's steps are a plain prose string (a Task), or a structured object: `{kind:'doc',...}` creates a Doc, `{kind:'rule',...}` creates a Rule, `{kind:'call',...}` nests another Playbook's own run as a pipeline step. `playbooks.invoke` validates and normalizes all arguments, safely renders placeholders in memory, validates the complete graph, then persists artifacts and edges in one transaction. Task dependencies, containment, gates, checklists, and context survive rendering. Run Rules are injected only while active focus belongs to that run. Docs retain invocation context and provenance; missing evidence references remain unknown and no gate runs during instantiation.

A run result has a stable schema: Playbook ID, run ID, normalized arguments, created IDs grouped by kind, ready root task IDs, and the bounded execution plan. Explicit run IDs produce deterministic artifact IDs (`<run-id>-<blueprint-ref>`); collisions roll back the entire run.

```bash
papyrus playbooks invoke <playbook-id> \
  --arguments-json '{"project":"Papyrus"}' \
  --json
```

### Removing an artifact

Artifacts are never hard-deleted on request: every artifact gets a permanent, immutable `created` row in the mutation event log the moment it exists, so removal is a real, time-gated trash rather than a status flip. `remove` (the shared `artifact.remove`/`artifact.remove_subtree` operations every agent-facing domain routes through, or `papyrus artifact remove <id> [--reason <text>]`) moves an artifact to the trash: it is immediately excluded from every list/query, still directly reachable by id, and fully recoverable via `restore` until its purge deadline (30 days later) passes. `remove` refuses a Task that is the live Task Focus in any scope.

Once the deadline passes, the daemon's periodic sweep performs a real, cascading, irreversible deletion — the one deliberate, narrow exception to Papyrus's otherwise-absolute append-only history, enforced by the database itself (not merely application code) via a trigger condition checked at delete time.

### Naming vs. ids

Every agent domain tool (tasks, docs, rules, playbooks, notes, discuss) addresses its artifacts by `name` (the exact title) wherever `id` would otherwise be required -- `dependency_name`/`parent_name`/`child_name`/`root_task_name`/`depends_on_names` (tasks), `target_name` (docs link, searches every kind since a link target can be any of them), `task_name` (rules gate, discuss block/unblock), and `blocks_task_names` (discuss open) are the name-based equivalents of their `*_id` counterparts. Resolution is an exact, case-insensitive, trimmed title match scoped like a plain list call; an unmatched or ambiguous name fails with a clear error (ambiguous names list the real ids, since that's the one point disambiguation genuinely needs them). Results returned to the agent likewise lead with name and status, never id, unless two artifacts in the same result share a title -- id is a backend implementation detail, not a conversational handle. `id` itself still works exactly as before for every action, in every tool.

### Mutability

Tasks, Docs, Rules, and Playbooks all support first-class `update` (title/body/labels, at least one required) alongside creation -- a Doc's body is no longer immutable once created. Every update is bounded the same way creation is (Rules keep their own stricter combined condition+action+body ceiling; Docs/Playbooks share Tasks' own length bounds) and recorded on the artifact's append-only mutation history, queryable via `graph.history`. An artifact carrying a `source:<system>` label (e.g. `source:web-spider` on an ingested page) is a read-only projection from a system Papyrus doesn't own the source of; updating one is refused with a clear error rather than silently forking it -- capture a correction as a new linked Doc instead until a write-back capability to that system exists. Notes stay behind their own facade for any content change, same as every other Notes mutation.

Internally, application services depend on the `ArtifactStore` and `GateRunner` ports. SQLite and subprocess execution are adapters composed only by the daemon; task behavior is unit-tested against fakes without a database. Task visualization projects the same `TaskGraph` into semantic display graphs and sends them through a `GraphRenderer` port -- the Pi adapter (in `@danypops/pi-papyrus`) uses `beautiful-mermaid` for terminal Unicode output without leaking Mermaid syntax into the task domain.

`src/index.ts` is this package's public surface for `@danypops/pi-papyrus` (and any other real npm consumer): explicit, named exports only, not a blanket re-export of internal daemon plumbing.
