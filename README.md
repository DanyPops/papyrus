# Papyrus

Graph artifact service for Pi — enforced SQLite schema, domain tools and services, and native interactive frontends.

Artifacts are rows in SQLite. Edges are typed relations. Kinds and relations are **registered and enforced**—the schema is the protocol. A supervised Bun daemon is the sole database owner; Pi extensions and other clients use its authenticated loopback service API.

## Architecture

```text
Pi tools + TUI
      ↓
tasks / docs / rules / skills domain tools
      ↓
Papyrus client → authenticated loopback daemon
      ↓
operation registry + lifecycle services
      ↓
graph-store operations → SQLite (WAL)
```

The `papyrus_*` tools remain low-level administration escape hatches. Normal agent work should use the domain tools.

## Storage and service

```text
$XDG_DATA_HOME/papyrus/papyrus.db       # durable graph
$XDG_RUNTIME_DIR/papyrus/{port,token}   # private daemon discovery
```

```bash
bun src/cli.ts service install   # install, enable, and start user service
bun src/cli.ts service status
bun src/cli.ts service restart

# Authenticated daemon-backed task automation (add --json for machine output)
papyrus tasks plan
papyrus tasks depend <task-id> <prerequisite-id>
papyrus tasks start <task-id>
papyrus tasks complete <task-id>
```

For repository work, install the versioned ownership guard once:

```bash
bun run guard:install
```

It blocks every Papyrus push whose destination is not `DanyPops/papyrus`, including explicit fallback URLs that bypass `origin`.

The daemon uses WAL, foreign keys, a bounded busy timeout, versioned migrations, periodic passive checkpoints, and periodic `PRAGMA optimize`. Keep the database on a local filesystem; SQLite WAL does not support network filesystems.

## Schema protocol (enforceable)

Papyrus enforces four artifact kinds:

- `doc` — knowledge: specifications, decisions, and research
- `task` — work: desired outcomes, gates, checklists, and dependencies
- `rule` — governance injected into the Pi system prompt
- `skill` — a parameterized workflow bundle whose validated arguments render a connected collection of deterministic Tasks plus contextual Rules and Docs

Each kind has an enforced status vocabulary. Every edge endpoint must exist, and every edge relation must be registered in `relation_names`. Relations are universal: any artifact kind can link to any other kind.

### Hierarchy and traversal

Use `contains` and `part_of` for explicit parent/child structure; use `depends_on` for execution ordering. Dependency edges form an executable DAG: self-dependencies and cycles are rejected, fan-in waits for every prerequisite, and fan-out may activate several successors. Graph reads are cycle-safe and bounded by `depth` and `max_nodes` (defaults: depth 4, 100 nodes; hard ceilings: depth 20, 1,000 nodes). Executable task plans are additionally bounded to 1,000 tasks and 10,000 relationships.

### Skills and compatibility templates

A Papyrus Skill is distinct from a conventional prompt-only skill: its input API and templates define a connected Task/Rule/Doc workflow. Task dependencies and gates provide deterministic execution; Rules provide scoped governance; Docs provide invocation context and provenance. The versioned workflow-instantiation API is tracked as active Papyrus work.

The existing `artifact-template` skill subtype remains a compatibility mechanism for one-artifact templates with metadata `{targetKind, defaults, required}`. Instantiate it through `papyrus_create` with `template_id`; defaults merge recursively, explicit arrays replace defaults, required paths such as `extra.owner` are validated, and target-kind mismatches are rejected.

## Tools

The `papyrus_*` tools are the low-level graph-store API:

- **`papyrus_create`** — create directly or instantiate via `template_id`
- **`papyrus_query`** — filter by kind/status or search title and body
- **`papyrus_graph`** — link artifacts, perform bounded traversal, or update status
- **`papyrus_show`** — read nested metadata and bounded edges, optionally running gates

Agent-facing domain tools own lifecycle invariants and sit above this store API:

- **`tasks`** — create/list/show/plan, replace evidence-bearing checklists, hierarchy/dependencies, start/fail/retry, non-blocking gates, and gate-enforced completion with automatic activation of newly ready successors
- **`docs`** — create/list/show, activate/archive/reopen, and document-safe graph links
- **`rules`** — create/list/show/preview, enable/disable, and attach governance gates to tasks
- **`skills`** — create/list/show/invoke, enable/disable, create templates, and instantiate templates

Every tool operation is registered in the daemon’s `/api/v1/ops` registry; parity is verified in tests. The task consumer uses the `tasks.graph` operation, which returns task nodes with explicit parent, child, and dependency IDs rather than leaking SQLite rows or asking the UI to reconstruct relationships.

Internally, application services depend on the `ArtifactStore` and `GateRunner` ports. SQLite and subprocess execution are adapters composed only by the daemon; task behavior is unit-tested against fakes without a database. Task visualization projects the same `TaskGraph` into semantic display graphs and sends them through a `GraphRenderer` port; the Pi adapter uses `beautiful-mermaid` for terminal Unicode output without leaking Mermaid syntax into the task domain.

## Interactive frontends

- `/tasks` — task lifecycle, gates, dependencies, and nested metadata
- `/docs` — searchable documents, lifecycle, details, and graph links
- `/rules` — severity/condition rows, exact injection preview, enable/disable, and task gating
- `/skills` — trigger/tools rows, invocation into the editor, and artifact templates

All four use daemon-backed domain operations; none opens SQLite from the Pi process.

## Tasks

Run `/tasks` for the interactive task panel:

- `/` filters; arrow keys navigate; Enter opens task actions
- `g` opens the programmatic Unicode graph; Tab switches dependency/composition views and arrow keys pan
- advance the `pending → active → done` lifecycle or retry `failed → pending`
- completing an active task runs only that task’s gates; success marks it done and activates every direct pending successor whose full prerequisite set is done
- successors are never auto-completed: each must pass its own gates; fan-in, fan-out, diamonds, and disconnected DAGs remain explicit
- inspect deterministic execution layers, readiness, a nested task hierarchy, composition, dependencies, evidence-bearing checklists, and verification gates
- Show details keeps Checklist and Validation gates separate from incidental Metadata, then renders relationships as a Unicode graph footer; `↑/↓` scrolls and `←/→` pans wide graphs
- the compact persistent widget shows active work in containment order, indents active children beneath active parents, and points to `/tasks` for the complete graph

Checklist criteria are an item-to-proof map. Every new item requires one or more typed references to inspectable evidence; proof presence does not imply that the evidence passed an executable gate:

```ts
checklist: {
  "Write failing skill-row tests": {
    proof: [
      { type: "file", target: "test/frontends.test.ts" },
      { type: "symbol", target: "test/frontends.test.ts#skill row test" }
    ]
  }
}
```

Proof types are `file`, `symbol`, `code`, `test`, `command`, `artifact`, and `url`. Existing array checklists remain readable as legacy items with `proof: missing`; Papyrus does not invent evidence.

Papyrus also injects an Alef-style reconciliation block on every agent turn while work remains: `Current`, `Desired`, `Verify`, and `Next`. The agent is explicitly instructed to ask **“Did we accomplish this task?”** and run gates before marking it done. The injection disappears when every task is complete.

In TUI and RPC modes, the extension checks bounded active Tasks at Pi’s public `agent_settled` lifecycle boundary. If active work remains and no continuation is already pending, it queues one hidden next turn so the agent continues instead of handing off merely because a low-level run ended. Active Tasks are the trigger; no manual command is required. Driving is single-flight and pauses after 20 automatic turns or 6 unchanged task snapshots; human input and task progress reset the bounded counters automatically.

## Why

Papyrus keeps SQLite’s local simplicity while centralizing writes, migrations, lifecycle invariants, gate execution, and maintenance in one small supervised process. The loopback bearer token prevents unrelated local HTTP callers from mutating the graph, while the native Pi extension provides richer domain tools and TUI integration.

## Install

Install the published Pi package, then install its supervised user service:

```bash
pi install npm:@danypops/papyrus
~/.pi/agent/npm/node_modules/.bin/papyrus service install
```

Reload Pi once the service is active. Git installs remain available for development builds:

```bash
pi install git:github.com/DanyPops/papyrus
```
